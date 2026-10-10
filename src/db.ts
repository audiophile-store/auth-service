import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 2000,
});

pool.on("error", () => {
  console.error("Database connection error");
});
