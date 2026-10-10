import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { openTestDatabase, withTestRollback } from "./test-database.js";

let client: Client;

before(async () => {
  client = await openTestDatabase();
});

after(async () => {
  if (client) {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

const userId = randomUUID();
const user = {
  id: userId,
  email: "admin@example.com",
  password_hash: "synthetic-password-hash",
  role: "admin",
  active: true,
};
const session = {
  token_hash: "a".repeat(64),
  user_id: userId,
  created_at: new Date("2026-10-10T12:00:00Z"),
  expires_at: new Date("2026-10-10T13:00:00Z"),
  revoked_at: null,
};

function insert(table: "users" | "sessions", overrides: Record<string, unknown> = {}) {
  const row = { ...(table === "users" ? user : session), ...overrides };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  return client.query<Record<string, unknown>>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    Object.values(row),
  );
}

test("stores the admin identity, password hash and creation time", async () => {
  await withTestRollback(client, async () => {
    const result = await insert("users");
    const row = result.rows[0];
    assert.ok(row);
    for (const [column, value] of Object.entries(user)) assert.equal(row[column], value);
    assert.ok(row.created_at instanceof Date);
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users'",
    );
    assert.equal(columns.rows.some((column) => column.column_name === "password"), false);
  });
});

for (const column of [...Object.keys(user), "created_at"]) {
  test(`users requires ${column}`, async () => {
    await withTestRollback(client, async () => {
      await assert.rejects(() => insert("users", { [column]: null }), { code: "23502" });
    });
  });
}

for (const column of ["id", "email"]) {
  test(`users rejects duplicate ${column}`, async () => {
    await withTestRollback(client, async () => {
      await insert("users");
      const overrides = column === "id"
        ? { email: "other@example.com" }
        : { id: randomUUID() };
      await assert.rejects(() => insert("users", overrides), { code: "23505" });
    });
  });
}

for (const overrides of [
  { email: "" },
  { email: "   " },
  { password_hash: "" },
  { password_hash: "   " },
  { role: "customer" },
]) {
  test(`users rejects invalid fields ${JSON.stringify(overrides)}`, async () => {
    await withTestRollback(client, async () => {
      await assert.rejects(() => insert("users", overrides), { code: "23514" });
    });
  });
}

test("allows deactivating the admin without deleting identity or sessions", async () => {
  await withTestRollback(client, async () => {
    await insert("users");
    await insert("sessions");
    await client.query("UPDATE users SET active = false WHERE id = $1", [userId]);
    const result = await client.query<{ active: boolean }>(
      "SELECT active FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(result.rows[0]?.active, false);
    const sessions = await client.query("SELECT token_hash FROM sessions WHERE user_id = $1", [userId]);
    assert.equal(sessions.rowCount, 1);
  });
});

test("stores only the token hash and retains independent sessions", async () => {
  await withTestRollback(client, async () => {
    await insert("users");
    const result = await insert("sessions");
    assert.deepEqual(result.rows[0]?.expires_at, session.expires_at);
    assert.equal(result.rows[0]?.revoked_at, null);
    await insert("sessions", { token_hash: "b".repeat(64) });
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sessions'",
    );
    assert.equal(columns.rows.some((column) => column.column_name === "token"), false);
    const updated = await client.query(
      "UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2",
      [new Date("2026-10-10T12:30:00Z"), session.token_hash],
    );
    assert.equal(updated.rowCount, 1);
    const remaining = await client.query(
      "SELECT token_hash FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    assert.equal(remaining.rowCount, 1);
    assert.equal(remaining.rows[0]?.token_hash, "b".repeat(64));
  });
});

for (const column of ["token_hash", "user_id", "created_at", "expires_at"]) {
  test(`sessions requires ${column}`, async () => {
    await withTestRollback(client, async () => {
      await insert("users");
      await assert.rejects(() => insert("sessions", { [column]: null }), { code: "23502" });
    });
  });
}

test("sessions requires an existing user", async () => {
  await withTestRollback(client, async () => {
    await assert.rejects(() => insert("sessions"), { code: "23503" });
  });
});

test("sessions rejects duplicate token hashes", async () => {
  await withTestRollback(client, async () => {
    await insert("users");
    await insert("sessions");
    await assert.rejects(() => insert("sessions"), { code: "23505" });
  });
});

for (const tokenHash of ["", "a".repeat(63), "a".repeat(65), "z".repeat(64)]) {
  test(`sessions rejects invalid SHA-256 representation (${tokenHash.length} characters)`, async () => {
    await withTestRollback(client, async () => {
      await insert("users");
      await assert.rejects(() => insert("sessions", { token_hash: tokenHash }), { code: "23514" });
    });
  });
}

test("sessions requires expiry after creation", async () => {
  await withTestRollback(client, async () => {
    await insert("users");
    await assert.rejects(
      () => insert("sessions", { expires_at: session.created_at }),
      { code: "23514" },
    );
  });
});
