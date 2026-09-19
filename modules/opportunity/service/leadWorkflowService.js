// Lead workflow actions that are events in their own right rather than plain
// field edits: the job-history log, role assignments (salesperson, estimator,
// operational coordinator) and the business-owner notification. Each
// assignment writes a system entry to the history so the trail is complete.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";
import { notify } from "../../notification/service/notificationService.js";

const { Opportunity, OpportunityHistory, User, UserBusinessUnit, BusinessUnit } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Role codes the workflow notifies (see seeders/roles-permissions.cjs). */
export const BUSINESS_OWNER_ROLE = "BO";
export const SALES_MANAGER_ROLE = "SMM";
export const OPERATIONS_COORDINATOR_ROLE = "OPC";

const loadOpportunity = async (id) => {
    const opportunity = await Opportunity.findByPk(parseId(id, "opportunity id"));
    if (!opportunity) throw httpError(404, "Opportunity not found");
    return opportunity;
};

// ---- Job history ------------------------------------------------------------

const historyInclude = () => [{ model: User, as: "author", attributes: ["id", "name"] }];

const presentHistory = (row) => {
    const plain = row.get({ plain: true });
    return {
        id: plain.id,
        opportunityId: plain.opportunityId,
        kind: plain.kind,
        note: plain.note,
        authorId: plain.authorId,
        authorName: plain.author?.name ?? null,
        createdAt: plain.createdAt,
    };
};

/** Every history entry for the record, newest first. */
export const listHistory = async (id) => {
    const opportunity = await loadOpportunity(id);
    const rows = await OpportunityHistory.findAll({
        where: { opportunityId: opportunity.id },
        include: historyInclude(),
        order: [["createdAt", "DESC"], ["id", "DESC"]],
    });
    return rows.map(presentHistory);
};

const createEntry = async (opportunity, note, kind, actor) => {
    const row = await OpportunityHistory.create({
        opportunityId: opportunity.id,
        authorId: actor?.id ?? null,
        kind,
        note,
    });
    return presentHistory(await OpportunityHistory.findByPk(row.id, { include: historyInclude() }));
};

/** A note a person adds on the History tab. */
export const addHistoryNote = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    const note = String(payload.note ?? "").trim();
    if (!note) throw httpError(400, "note is required");
    if (note.length > 5000) throw httpError(400, "note is too long (5000 characters max)");
    return createEntry(opportunity, note, "note", actor);
};

export const recordSystemEvent = (opportunity, note, actor) => createEntry(opportunity, note, "system", actor);

// ---- Assignments ------------------------------------------------------------

// Work can only be assigned to an active person who belongs to the record's
// business unit (ADM accounts work in every unit).
export const assertAssignable = async (userId, opportunity, label) => {
    const user = await User.findByPk(parseId(userId, label));
    if (!user) throw httpError(400, `Unknown user for ${label}`);
    if (user.status !== "active") throw httpError(400, `${user.name} is not an active account`);
    const isAdmin = Array.isArray(user.roles) && user.roles.includes(SUPER_ROLE_CODE);
    if (!isAdmin) {
        const link = await UserBusinessUnit.findOne({
            where: { userId: user.id, businessUnitId: opportunity.businessUnitId },
            attributes: ["id"],
        });
        if (!link) throw httpError(400, `${user.name} is not assigned to this business unit`);
    }
    return user;
};

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

/**
 * { salespersonId: number | null, reason? } — leaving the lead unassigned
 * needs a reason, which is kept on the record (unassignedReason).
 */
export const assignSalesperson = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (isBlank(payload.salespersonId)) {
        const reason = String(payload.reason ?? "").trim();
        if (!reason) throw httpError(400, "Give a reason when leaving the lead without a salesperson");
        if (reason.length > 2000) throw httpError(400, "reason is too long");
        const changed = opportunity.salespersonId !== null;
        await opportunity.update({ salespersonId: null, unassignedReason: reason });
        if (changed) await recordSystemEvent(opportunity, "Salesperson unassigned", actor);
        return opportunity.id;
    }
    const user = await assertAssignable(payload.salespersonId, opportunity, "salesperson");
    const changed = opportunity.salespersonId !== user.id;
    await opportunity.update({ salespersonId: user.id, unassignedReason: null });
    if (changed) {
        await recordSystemEvent(opportunity, `Salesperson assigned: ${user.name}`, actor);
        await notifyAssignee(opportunity, { event: "assignment.salesperson", user, role: "Salesperson" }, actor);
    }
    return opportunity.id;
};

/** { estimatorId } */
export const assignEstimator = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (isBlank(payload.estimatorId)) throw httpError(400, "estimatorId is required");
    const user = await assertAssignable(payload.estimatorId, opportunity, "estimator");
    const changed = opportunity.estimatorId !== user.id;
    await opportunity.update({ estimatorId: user.id });
    if (changed) {
        await recordSystemEvent(opportunity, `Estimator assigned: ${user.name}`, actor);
        await notifyAssignee(opportunity, { event: "assignment.estimator", user, role: "Estimator" }, actor);
    }
    return opportunity.id;
};

/** { operationalCoordinatorId } — who runs the client visit. */
export const assignCoordinator = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (isBlank(payload.operationalCoordinatorId)) throw httpError(400, "operationalCoordinatorId is required");
    const user = await assertAssignable(payload.operationalCoordinatorId, opportunity, "operational coordinator");
    const changed = opportunity.operationalCoordinatorId !== user.id;
    await opportunity.update({ operationalCoordinatorId: user.id, needsClientVisit: true });
    if (changed) {
        await recordSystemEvent(opportunity, `Operational coordinator assigned: ${user.name}`, actor);
        await notifyAssignee(
            opportunity,
            { event: "assignment.coordinator", user, role: "Operations coordinator" },
            actor
        );
    }
    return opportunity.id;
};

// ---- Notifications ----------------------------------------------------------

/**
 * Notifies every holder of a role in the record's unit (plus any named users,
 * e.g. the assigned salesperson) and records who was told in the job history.
 * Zero recipients is not an error — the unit may simply have nobody in that
 * role yet. The notification itself is raised by notificationService.notify,
 * which decides the priority and pushes it to open browsers.
 */
const notifyRole = async (opportunity, { event, roleCode, roleLabel, extraUserIds = [], title, body }, actor) => {
    const { recipients } = await notify({
        event,
        title,
        body,
        roleCode,
        userIds: extraUserIds,
        opportunity,
        actor,
        // A notification someone triggers for a role they hold themselves is
        // still worth keeping in their inbox — it is the record of the handoff.
        includeActor: true,
    });
    await recordSystemEvent(
        opportunity,
        recipients.length
            ? `${roleLabel} notified: ${recipients.map((u) => u.name).join(", ")}`
            : `No ${roleLabel.toLowerCase()} account in this unit to notify`,
        actor
    );
    return { notified: recipients.length, recipients };
};

/**
 * Tells someone work has landed on them. Called by every assignment below, so
 * a new assignment kind only has to add its event to notificationEvents.js.
 */
const notifyAssignee = (opportunity, { event, user, role }, actor) =>
    notify({
        event,
        title: `${role} on ${opportunity.number}`,
        body: `${customerOf(opportunity)} — you are now the ${role.toLowerCase()}${actor?.name ? `, assigned by ${actor.name}` : ""}.`,
        userIds: [user.id],
        opportunity,
        actor, // assigning work to yourself raises nothing
    });

const unitNameOf = async (opportunity) =>
    (await BusinessUnit.findByPk(opportunity.businessUnitId, { attributes: ["id", "name"] }))?.name ?? "the business unit";

const customerOf = (opportunity) => opportunity.customerLegalName || opportunity.customerTradingName || "A new customer";

/** Tells every active Business Owner in the unit about a newly captured lead. */
export const notifyBusinessOwner = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    const unitName = await unitNameOf(opportunity);
    return notifyRole(
        opportunity,
        {
            event: "lead.captured",
            roleCode: BUSINESS_OWNER_ROLE,
            roleLabel: "Business owner",
            title: `New lead ${opportunity.number}`,
            body: `${customerOf(opportunity)} was captured in ${unitName}${actor?.name ? ` by ${actor.name}` : ""}.`,
        },
        actor
    );
};

/**
 * Estimation has sent the lead back: tells the Sales & Marketing Manager(s)
 * and the assigned salesperson what is still missing.
 */
export const notifySalesManager = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    const reason = opportunity.estimationOnHoldReason ? ` Missing: ${opportunity.estimationOnHoldReason}` : "";
    return notifyRole(
        opportunity,
        {
            event: "estimation.on_hold",
            roleCode: SALES_MANAGER_ROLE,
            roleLabel: "Sales manager",
            extraUserIds: [opportunity.salespersonId],
            title: `Estimation on hold: ${opportunity.number}`,
            body: `${customerOf(opportunity)} needs more information from sales before it can be estimated.${reason}`,
        },
        actor
    );
};

/**
 * A pre-site inspection is needed: tells the Operations Coordinator(s) and
 * the coordinator assigned to the record to line up a site team member.
 */
export const notifyOperationsCoordinator = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    return notifyRole(
        opportunity,
        {
            event: "estimation.site_visit",
            roleCode: OPERATIONS_COORDINATOR_ROLE,
            roleLabel: "Operations coordinator",
            extraUserIds: [opportunity.operationalCoordinatorId],
            title: `Site visit needed: ${opportunity.number}`,
            body: `${customerOf(opportunity)} needs a pre-site inspection — assign a site team member.`,
        },
        actor
    );
};

/**
 * Tells the assigned estimator that the lead pack changed under them, after a
 * save on a record already handed over. { summary? } — what changed, in the
 * saver's words; it is kept on the record until the estimator acknowledges it.
 */
export const notifyEstimator = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (!opportunity.estimatorId) return { notified: 0, recipients: [] };

    const summary = String(payload?.summary ?? "").trim().slice(0, 2000) || "The lead details were updated.";
    await opportunity.update({ leadChangeSummary: summary, leadEditedAt: new Date(), leadChangeAcknowledgedAt: null });

    const { recipients } = await notify({
        event: "lead.changed",
        title: `${opportunity.number}: lead details changed`,
        body: `${actor?.name || "Sales"} updated ${customerOf(opportunity)} after handover — ${summary}`,
        userIds: [opportunity.estimatorId],
        opportunity,
        actor,
    });
    await recordSystemEvent(opportunity, "Estimator told the lead details changed", actor);
    return { notified: recipients.length, recipients };
};
