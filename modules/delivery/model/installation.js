// A completed installation: when, what job it was, the signed quote it
// delivered, how the customer pays and whether it has been invoiced.
export const PAYMENT_METHODS = ["cash", "loan", "card", "bank_transfer", "other"];
export const INVOICE_STATUSES = ["not_invoiced", "invoiced", "partially_paid", "paid"];

export default (sequelize, DataTypes) => {
    const Installation = sequelize.define(
        "Installation",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            opportunityId: { type: DataTypes.INTEGER, allowNull: false },
            businessUnitId: { type: DataTypes.INTEGER, allowNull: false },
            projectId: { type: DataTypes.INTEGER, allowNull: true },
            jobScheduleId: { type: DataTypes.INTEGER, allowNull: true },
            installationDate: { type: DataTypes.DATEONLY, allowNull: false },
            jobDescription: { type: DataTypes.STRING(2000) },
            installerId: { type: DataTypes.INTEGER, allowNull: true },
            signedQuoteVersionId: { type: DataTypes.INTEGER, allowNull: true },
            systemSummary: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            paymentMethod: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "cash", validate: { isIn: [PAYMENT_METHODS] } },
            invoiceStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "not_invoiced", validate: { isIn: [INVOICE_STATUSES] } },
            invoiceNumber: { type: DataTypes.STRING(60) },
            notes: { type: DataTypes.TEXT },
            completedById: { type: DataTypes.INTEGER, allowNull: true },
        },
        { tableName: "installations" }
    );

    Installation.associate = (db) => {
        Installation.belongsTo(db.Opportunity, { foreignKey: "opportunityId", as: "opportunity" });
        Installation.belongsTo(db.BusinessUnit, { foreignKey: "businessUnitId", as: "businessUnit" });
        Installation.belongsTo(db.Project, { foreignKey: "projectId", as: "project" });
        Installation.belongsTo(db.JobSchedule, { foreignKey: "jobScheduleId", as: "jobSchedule" });
        Installation.belongsTo(db.User, { foreignKey: "installerId", as: "installer" });
        Installation.belongsTo(db.QuoteVersion, { foreignKey: "signedQuoteVersionId", as: "signedQuoteVersion" });
        Installation.belongsTo(db.User, { foreignKey: "completedById", as: "completedBy" });
    };

    return Installation;
};
