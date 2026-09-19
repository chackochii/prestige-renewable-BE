import "dotenv/config";
import app from "./app.js";
import { connectDB } from "./config/db.js";
import { startSlaWatcher } from "./modules/notification/service/slaWatcher.js";

const PORT = process.env.PORT || 8000;
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const start = async () => {
    await connectDB();
    app.listen(PORT, () => {
        console.log(`✅ Server is running on ${BACKEND_URL}`);
    });
    // Raises the "past SLA" notifications; see SLA_CHECK_INTERVAL_MINUTES.
    startSlaWatcher();
};

start();
