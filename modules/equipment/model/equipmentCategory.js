// Equipment and service categories: a category ID (CAT-001), the kind, and
// whether it is active. Items count against a category (equipment.category_id);
// a category with items can be deactivated but not removed.
export const CATEGORY_KINDS = ["equipment", "service"];

export default (sequelize, DataTypes) => {
    const EquipmentCategory = sequelize.define(
        "EquipmentCategory",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
            name: { type: DataTypes.STRING(120), allowNull: false },
            kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "equipment", validate: { isIn: [CATEGORY_KINDS] } },
            description: { type: DataTypes.STRING(500) },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        { tableName: "equipment_categories" }
    );

    EquipmentCategory.associate = (db) => {
        EquipmentCategory.hasMany(db.Equipment, { foreignKey: "categoryId", as: "items" });
    };

    return EquipmentCategory;
};
