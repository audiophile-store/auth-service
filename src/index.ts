import { createApp } from "./app.js";
import { pool } from "./db.js";

if (!process.env.AUTH_ALLOWED_ORIGINS) {
  console.warn("AUTH_ALLOWED_ORIGINS is not configured; login and logout requests will be denied");
}

const app = createApp(pool, {
  allowedOrigins: (process.env.AUTH_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  secureCookies: process.env.NODE_ENV !== "development",
});
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
