import { Sequelize } from "sequelize";
import config from "./config.cjs";

const env = process.env.NODE_ENV || "development";
const dbConfig = config[env];

export const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, dbConfig);

export const connectDB = async () => {
    try {
        await sequelize.authenticate();
        console.log(`✅ PostgreSQL connected: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    } catch (error) {
        console.error(`❌ PostgreSQL connection failed: ${error.message}`);
        process.exit(1);
    }
};

export default connectDB;
