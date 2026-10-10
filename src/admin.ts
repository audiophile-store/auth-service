import type { Pool } from "pg";
import { hashPassword } from "./passwords.js";
import { validateEmail, validateNewPassword } from "./validation.js";

type Database = Pick<Pool, "query">;

export async function createAdmin(database: Database, email: unknown, password: unknown): Promise<string> {
  const normalizedEmail = validateEmail(email);
  const passwordHash = await hashPassword(validateNewPassword(password));
  const result = await database.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id",
    [normalizedEmail, passwordHash],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Admin creation returned no identity");
  return id;
}

export async function changeAdminPassword(database: Database, email: unknown, password: unknown): Promise<string> {
  const normalizedEmail = validateEmail(email);
  const passwordHash = await hashPassword(validateNewPassword(password));
  const result = await database.query<{ id: string }>(
    `WITH changed_admin AS (
       UPDATE users SET password_hash = $2
       WHERE email = $1 AND role = 'admin' RETURNING id
     ), revoked_sessions AS (
       UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id IN (SELECT id FROM changed_admin) AND revoked_at IS NULL
     )
     SELECT id FROM changed_admin`,
    [normalizedEmail, passwordHash],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Admin not found");
  return id;
}
