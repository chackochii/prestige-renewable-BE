// Who in a business unit holds a permission: the active users assigned to the
// unit whose roles grant it (own or inherited grants). For notifications that
// go "to whoever may approve this" rather than to one role code.
import { Op } from "sequelize";
import db from "../models/index.js";
import { roleCodesWithPermission } from "../modules/role/service/roleService.js";

export const usersWithPermissionIn = async (businessUnitId, permissionCode) => {
    if (!businessUnitId) return [];
    const codes = await roleCodesWithPermission(permissionCode);
    const links = await db.UserBusinessUnit.findAll({ where: { businessUnitId }, attributes: ["userId"] });
    if (!links.length || !codes.length) return [];
    return db.User.findAll({
        where: { id: { [Op.in]: links.map((l) => l.userId) }, status: "active", roles: { [Op.overlap]: codes } },
        attributes: ["id", "name", "roles"],
    });
};

export default usersWithPermissionIn;
