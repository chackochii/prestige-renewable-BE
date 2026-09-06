// Registry of navigable pages/modules. The sidebar is built from this table:
// a user sees a page when they hold its viewPermissionCode (ADM bypasses) AND
// the page is enabled for the business unit they are working in. Adding a
// page later is an insert (seeder or POST /pages), not a code change.
export default (sequelize, DataTypes) => {
    const AppPage = sequelize.define(
        "AppPage",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            code: { type: DataTypes.STRING(30), allowNull: false, unique: true }, // e.g. "pipeline"
            label: { type: DataTypes.STRING, allowNull: false }, // sidebar text, e.g. "Pipeline"
            path: { type: DataTypes.STRING(100), allowNull: false, unique: true }, // route, e.g. "/pipeline"
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            // Permission a user must hold to see the page; null = every
            // authenticated user. Codes live in the permissions catalog so
            // role → page visibility is edited on the roles screen, as data.
            viewPermissionCode: { type: DataTypes.STRING(50), allowNull: true },
            // System pages back real routes in the frontend; not deletable.
            isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        },
        { tableName: "app_pages" }
    );

    AppPage.associate = (db) => {
        AppPage.hasMany(db.BusinessUnitPage, { foreignKey: "pageId", as: "unitOverrides" });
    };

    return AppPage;
};
