// Referrer directory reads. Management (create/edit, commission details)
// arrives with the referrers module; the lead form only needs the list.
import db from "../../../models/index.js";

const { Referrer } = db;

export const listReferrers = ({ status = "active" } = {}) =>
    Referrer.findAll({
        where: status === "all" ? {} : { status },
        attributes: ["id", "organisation", "contactName", "status"],
        order: [["organisation", "ASC"]],
    });
