import { SUPER_ROLE_CODE } from "../modules/role/service/roleService.js";

// Deny-by-default business-unit scoping, shared by the route guards in
// middleware/requireUnitAccess and by services that take an actor.
//
// A user only works in the units they are assigned to (users_business_units);
// ADM is unrestricted. tokenValidator loads the assignment list onto
// req.user.businessUnitIds once per request.

const isSuperAdmin = (user) => Array.isArray(user?.roles) && user.roles.includes(SUPER_ROLE_CODE);

// null = unrestricted, otherwise the unit ids the user may touch.
export const unitScopeOf = (user) => {
    if (!user || isSuperAdmin(user)) return null;
    return Array.isArray(user.businessUnitIds) ? user.businessUnitIds : [];
};

export const canAccessUnit = (user, unitId) => {
    const scope = unitScopeOf(user);
    return scope === null || scope.includes(Number(unitId));
};

// For services: throws the same 403 the user module uses for an out-of-scope
// unit, so the API speaks with one voice.
export const assertUnitAccess = (user, unitId) => {
    if (!canAccessUnit(user, unitId))
        throw Object.assign(new Error("This business unit is outside your assignments"), { status: 403 });
};

export default unitScopeOf;
