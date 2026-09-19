// Watches for work that has run past its date and tells whoever owns it:
// records whose stage SLA has run out, and collaboration requests past their
// due date. Nothing else in the app runs on a timer, so this is a plain
// interval started by server.js rather than a job queue.
//
// It re-checks every few minutes and would otherwise raise the same notice
// over and over; the dedupe key ("sla:<record>:<due date>") makes it once per
// person per deadline. That also keeps it safe if two instances run it — the
// unique index on (user_id, dedupe_key) drops the second insert.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import logger from "../../../utils/logger.js";
import { notify } from "./notificationService.js";
import { assignedUserIds, customerLabel } from "../../opportunity/service/opportunityPeople.js";
import { overdueRequests } from "../../collaboration/service/collaborationService.js";

const { Opportunity } = db;

const DEFAULT_INTERVAL_MINUTES = 15;
// A record whose deadline passed long ago is history, not news: only look
// back this far on the first pass after a restart.
const LOOK_BACK_DAYS = 14;

/** One pass: notifies for every active record past its SLA. Returns how many notices went out. */
export const runSlaCheck = async () => {
    const now = new Date();
    const overdue = await Opportunity.findAll({
        where: {
            lifecycle: "Active",
            slaDueAt: { [Op.lt]: now, [Op.gt]: new Date(now.getTime() - LOOK_BACK_DAYS * 86400000) },
        },
        attributes: [
            "id", "number", "businessUnitId", "stage", "slaDueAt", "customerLegalName", "customerTradingName",
            "leadOwnerId", "salespersonId", "estimatorId", "operationalCoordinatorId", "deliveryOwnerId",
        ],
    });

    let raised = 0;
    for (const opportunity of overdue) {
        const userIds = assignedUserIds(opportunity);
        if (!userIds.length) continue;
        const due = new Date(opportunity.slaDueAt);
        const days = Math.max(1, Math.round((now - due) / 86400000));
        const { created } = await notify({
            event: "sla.overdue",
            title: `${opportunity.number} is past its SLA`,
            body: `${customerLabel(opportunity)} — stage ${opportunity.stage} was due ${due.toISOString().slice(0, 10)}, ${days} day${days === 1 ? "" : "s"} ago.`,
            userIds,
            opportunity,
            dedupeKey: `sla:${opportunity.id}:${due.toISOString()}`,
        });
        raised += created;
    }
    return raised;
};

/** One pass over collaboration requests that are open and past their due date. */
export const runOverdueRequestCheck = async () => {
    const since = new Date(Date.now() - LOOK_BACK_DAYS * 86400000);
    const overdue = await overdueRequests(since);

    let raised = 0;
    for (const request of overdue) {
        const due = new Date(request.dueAt);
        const { created } = await notify({
            event: "request.overdue",
            title: `${request.kind === "assignment" ? "ASG" : "REQ"}-${request.id} is past its due date`,
            body: `"${request.title}"${request.opportunity?.number ? ` on ${request.opportunity.number}` : ""} was due ${due.toISOString().slice(0, 10)}.`,
            userIds: [request.assigneeId],
            businessUnitId: request.businessUnitId,
            dedupeKey: `request-overdue:${request.id}:${due.toISOString()}`,
        });
        raised += created;
    }
    return raised;
};

/**
 * Starts the periodic check. SLA_CHECK_INTERVAL_MINUTES=0 turns it off (tests,
 * one-off scripts). Returns a stop function.
 */
export const startSlaWatcher = () => {
    const minutes = Number(process.env.SLA_CHECK_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        logger.info("SLA watcher disabled (SLA_CHECK_INTERVAL_MINUTES=0)");
        return () => {};
    }

    let running = false;
    const pass = async () => {
        // A slow pass must not overlap the next tick.
        if (running) return;
        running = true;
        try {
            const raised = (await runSlaCheck()) + (await runOverdueRequestCheck());
            if (raised) logger.info(`SLA watcher: ${raised} overdue notification(s) raised`);
        } catch (err) {
            logger.error(`SLA watcher failed: ${err.stack ?? err.message}`);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(pass, minutes * 60000);
    // Never hold the process open just for this.
    timer.unref();
    pass();
    logger.info(`SLA watcher running every ${minutes} minute(s)`);
    return () => clearInterval(timer);
};
