// DNSP networks — the list behind CL-07 item 1. Read by every signed-in user
// (the approvals checklist needs it); changed by the system administrator only.
//
// Jobs store the network's name, not its id, so edits here never rewrite a
// job's answers: a renamed or removed network keeps showing on the jobs that
// already picked it.
import db from "../../../models/index.js";
import { parseId } from "../../../utils/ids.js";

const { DnspNetwork } = db;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const NAME_MAX = 100;
const STATE_MAX = 10;

const toDto = (row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
});

const cleanName = (value) => {
    if (typeof value !== "string" || !value.trim()) throw httpError(400, "name is required");
    const name = value.trim();
    if (name.length > NAME_MAX) throw httpError(400, `name must be at most ${NAME_MAX} characters`);
    return name;
};

const cleanState = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw httpError(400, "state must be a string");
    const state = value.trim().toUpperCase();
    if (state.length > STATE_MAX) throw httpError(400, `state must be at most ${STATE_MAX} characters`);
    return state || null;
};

const cleanSortOrder = (value) => {
    const order = Number(value);
    if (!Number.isInteger(order)) throw httpError(400, "sortOrder must be a whole number");
    return order;
};

// Names are compared case-insensitively — "ausgrid" and "Ausgrid" would be
// the same network on the dropdown.
const assertNameFree = async (name, exceptId = null) => {
    const clash = await DnspNetwork.findOne({
        where: db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col("name")), name.toLowerCase()),
    });
    if (clash && clash.id !== exceptId) throw httpError(409, `A network named "${clash.name}" already exists`);
};

const findNetwork = async (id) => {
    const row = await DnspNetwork.findByPk(parseId(id, "network id"));
    if (!row) throw httpError(404, "DNSP network not found");
    return row;
};

/** Every network in dropdown order, active and inactive: [{ id, name, state, isActive, sortOrder }]. */
export const listDnspNetworks = async () => {
    const rows = await DnspNetwork.findAll({
        order: [["sortOrder", "ASC"], ["name", "ASC"]],
    });
    return rows.map(toDto);
};

/** payload: { name, state?, isActive?, sortOrder? } — new networks go to the end unless sortOrder is given. */
export const createDnspNetwork = async (payload = {}) => {
    const name = cleanName(payload.name);
    await assertNameFree(name);
    const sortOrder =
        payload.sortOrder !== undefined ? cleanSortOrder(payload.sortOrder) : ((await DnspNetwork.max("sortOrder")) ?? -1) + 1;
    const row = await DnspNetwork.create({
        name,
        state: cleanState(payload.state),
        isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
        sortOrder,
    });
    return toDto(row);
};

/** payload: any of { name, state, isActive, sortOrder }. */
export const updateDnspNetwork = async (id, payload = {}) => {
    const row = await findNetwork(id);
    const updates = {};
    if (payload.name !== undefined) {
        updates.name = cleanName(payload.name);
        await assertNameFree(updates.name, row.id);
    }
    if (payload.state !== undefined) updates.state = cleanState(payload.state);
    if (payload.isActive !== undefined) updates.isActive = Boolean(payload.isActive);
    if (payload.sortOrder !== undefined) updates.sortOrder = cleanSortOrder(payload.sortOrder);
    if (Object.keys(updates).length === 0)
        throw httpError(400, "No fields provided. Editable: name, state, isActive, sortOrder");
    await row.update(updates);
    return toDto(row);
};

export const deleteDnspNetwork = async (id) => {
    const row = await findNetwork(id);
    await row.destroy();
};
