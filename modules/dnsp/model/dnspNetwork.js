// A distribution network (DNSP) the coordinator can pick on the DNSP
// application (CL-07). Maintained by the system administrator; inactive
// networks stay listed for jobs already recorded against them but are not
// offered for new ones.
export default (sequelize, DataTypes) => {
    const DnspNetwork = sequelize.define(
        "DnspNetwork",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
            state: { type: DataTypes.STRING(10), allowNull: true },
            isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        },
        { tableName: "dnsp_networks" }
    );

    return DnspNetwork;
};
