import { changeAdminPassword, createAdmin } from "./admin.js";
import { readAdminCredentials } from "./admin-input.js";

const safeMessages = new Set([
  "An interactive terminal is required",
  "Admin input cancelled",
  "Invalid email",
  "Invalid password",
  "Passwords do not match",
  "Admin not found",
  "DATABASE_URL is required",
  "Use create or change-password with no additional arguments",
]);

try {
  const command = process.argv[2];
  if (process.argv.length !== 3 || (command !== "create" && command !== "change-password")) {
    throw new Error("Use create or change-password with no additional arguments");
  }
  const { email, password } = await readAdminCredentials();
  const { pool } = await import("./db.js");
  try {
    if (command === "create") {
      await createAdmin(pool, email, password);
      console.log("Admin created");
    } else {
      await changeAdminPassword(pool, email, password);
      console.log("Admin password changed; all sessions revoked");
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  const message = error instanceof Error && safeMessages.has(error.message)
    ? error.message
    : typeof error === "object" && error !== null && "code" in error && error.code === "23505"
      ? "Admin email already exists"
      : "Database or password hashing operation failed";
  console.error(`Admin command failed: ${message}`);
  process.exitCode = 1;
}
