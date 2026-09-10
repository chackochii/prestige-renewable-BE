// Lead workflow actions that are events in their own right rather than plain
// field edits: the job-history log, role assignments (salesperson, estimator,
// operational coordinator) and the business-owner notification. Each
// assignment writes a system entry to the history so the trail is complete.
import { Op } from "sequelize";
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";
import { SUPER_ROLE_CODE } from "../../role/service/roleService.js";

const { Opportunity, OpportunityHistory, User, UserBusinessUnit, BusinessUnit, Notification } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Role code of the people who are told about every new lead in their unit. */
export const BUSINESS_OWNER_ROLE = "BO";

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

const recordSystemEvent = (opportunity, note, actor) => createEntry(opportunity, note, "system", actor);

// ---- Assignments ------------------------------------------------------------

// Work can only be assigned to an active person who belongs to the record's
// business unit (ADM accounts work in every unit).
const assertAssignable = async (userId, opportunity, label) => {
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
    if (changed) await recordSystemEvent(opportunity, `Salesperson assigned: ${user.name}`, actor);
    return opportunity.id;
};

/** { estimatorId } */
export const assignEstimator = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (isBlank(payload.estimatorId)) throw httpError(400, "estimatorId is required");
    const user = await assertAssignable(payload.estimatorId, opportunity, "estimator");
    const changed = opportunity.estimatorId !== user.id;
    await opportunity.update({ estimatorId: user.id });
    if (changed) await recordSystemEvent(opportunity, `Estimator assigned: ${user.name}`, actor);
    return opportunity.id;
};

/** { operationalCoordinatorId } — who runs the client visit. */
export const assignCoordinator = async (id, payload = {}, actor) => {
    const opportunity = await loadOpportunity(id);
    if (isBlank(payload.operationalCoordinatorId)) throw httpError(400, "operationalCoordinatorId is required");
    const user = await assertAssignable(payload.operationalCoordinatorId, opportunity, "operational coordinator");
    const changed = opportunity.operationalCoordinatorId !== user.id;
    await opportunity.update({ operationalCoordinatorId: user.id, needsClientVisit: true });
    if (changed) await recordSystemEvent(opportunity, `Operational coordinator assigned: ${user.name}`, actor);
    return opportunity.id;
};

// ---- Notifications ----------------------------------------------------------

/**
 * Creates an in-app notification for every active Business Owner in the
 * record's unit. Returns who was notified; zero recipients is not an error
 * (the unit may simply have no owner account yet).
 */
export const notifyBusinessOwner = async (id, actor) => {
    const opportunity = await loadOpportunity(id);
    const unit = await BusinessUnit.findByPk(opportunity.businessUnitId, { attributes: ["id", "name"] });
    const links = await UserBusinessUnit.findAll({
        where: { businessUnitId: opportunity.businessUnitId },
        attributes: ["userId"],
    });
    const owners = links.length
        ? await User.findAll({
              where: {
                  id: { [Op.in]: links.map((link) => link.userId) },
                  status: "active",
                  roles: { [Op.contains]: [BUSINESS_OWNER_ROLE] },
              },
              attributes: ["id", "name"],
          })
        : [];

    const customer = opportunity.customerLegalName || opportunity.customerTradingName || "A new customer";
    const title = `New lead ${opportunity.number}`;
    const body = `${customer} was captured in ${unit?.name ?? "the business unit"}${actor?.name ? ` by ${actor.name}` : ""}.`;
    if (owners.length)
        await Notification.bulkCreate(
            owners.map((owner) => ({ userId: owner.id, opportunityId: opportunity.id, title, body }))
        );
    await recordSystemEvent(
        opportunity,
        owners.length
            ? `Business owner notified: ${owners.map((o) => o.name).join(", ")}`
            : "No business owner account in this unit to notify",
        actor
    );
    return { notified: owners.length, recipients: owners.map((o) => ({ id: o.id, name: o.name })) };
};
