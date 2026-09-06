// Route params arrive as strings; primary keys are auto-increment integers.
// Returns the id as a number, or throws a 400 for anything that isn't a
// positive integer — so garbage ids surface as client errors, not database
// type errors.
export const parseId = (value, label = "id") => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0)
        throw Object.assign(new Error(`${label} must be a positive integer`), { status: 400 });
    return id;
};

export default parseId;
