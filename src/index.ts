import { createApp } from "./app.js";
import { pool } from "./db.js";

const app = createApp();
const PORT = process.env.PORT || 3000;

try {
  await pool.query("SELECT 1");
  app.listen(PORT, () => {
    console.log(`auth service listening on port ${PORT}`);
  });
} catch {
  console.error("Unable to start auth service: database connection failed");
  await pool.end();
  process.exitCode = 1;
}
