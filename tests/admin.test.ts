import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { changeAdminPassword, createAdmin } from "../src/admin.js";
import { verifyPassword } from "../src/passwords.js";
import { openTestDatabase, withTestRollback } from "./test-database.js";

let client: Client;
const password = "Synthetic-Admin-Password!";
const newPassword = "Synthetic-New-Password!";

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

test("admin creation normalizes email and stores only an Argon2id hash", async () => {
  await withTestRollback(client, async () => {
    const id = await createAdmin(client, " Admin@Example.COM ", password);
    const result = await client.query("SELECT * FROM users WHERE id = $1", [id]);
    const user = result.rows[0];
    assert.ok(user);
    assert.equal(user.email, "admin@example.com");
    assert.equal(user.role, "admin");
    assert.equal(user.active, true);
    assert.match(user.password_hash, /^\$argon2id\$/);
    assert.notEqual(user.password_hash, password);
    assert.equal(await verifyPassword(password, user.password_hash), true);
    assert.equal((await client.query("SELECT * FROM sessions")).rowCount, 0);
  });
});

test("duplicate normalized admin email is rejected without replacing credentials", async () => {
  await withTestRollback(client, async () => {
    const id = await createAdmin(client, "admin@example.com", password);
    await client.query("SAVEPOINT duplicate_admin");
    await assert.rejects(() => createAdmin(client, " ADMIN@EXAMPLE.COM ", newPassword), {
      code: "23505",
    });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_admin");
    const result = await client.query("SELECT password_hash FROM users WHERE id = $1", [id]);
    assert.equal(await verifyPassword(password, result.rows[0].password_hash), true);
    assert.equal((await client.query("SELECT * FROM users")).rowCount, 1);
  });
});

for (const operation of [createAdmin, changeAdminPassword]) {
  test(`${operation.name} rejects invalid input before writing`, async () => {
    await withTestRollback(client, async () => {
      await assert.rejects(() => operation(client, "invalid-email", password), { message: "Invalid email" });
      await assert.rejects(() => operation(client, "admin@example.com", "weak"), { message: "Invalid password" });
      assert.equal((await client.query("SELECT * FROM users")).rowCount, 0);
    });
  });
}

test("password change revokes all admin sessions, preserving other users and prior revocations", async () => {
  await withTestRollback(client, async () => {
    const id = await createAdmin(client, "admin@example.com", password);
    const otherId = await createAdmin(client, "other@example.com", password);
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, revoked_at) VALUES
       ($1, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', NULL),
       ($2, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', NULL),
       ($3, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP),
       ($4, $6, CURRENT_TIMESTAMP + INTERVAL '1 hour', NULL)`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), id, otherId],
    );
    const previous = await client.query("SELECT revoked_at FROM sessions WHERE token_hash = $1", ["c".repeat(64)]);
    assert.equal(await changeAdminPassword(client, " ADMIN@EXAMPLE.COM ", newPassword), id);
    const users = await client.query("SELECT id, password_hash FROM users");
    for (const user of users.rows) {
      assert.equal(await verifyPassword(user.id === id ? newPassword : password, user.password_hash), true);
      if (user.id === id) assert.equal(await verifyPassword(password, user.password_hash), false);
    }
    const sessions = await client.query("SELECT * FROM sessions ORDER BY token_hash");
    assert.ok(sessions.rows[0].revoked_at instanceof Date);
    assert.ok(sessions.rows[1].revoked_at instanceof Date);
    assert.deepEqual(sessions.rows[2].revoked_at, previous.rows[0].revoked_at);
    assert.equal(sessions.rows[3].revoked_at, null);
  });
});

test("missing admin password change fails explicitly", async () => {
  await withTestRollback(client, async () => {
    await assert.rejects(() => changeAdminPassword(client, "missing@example.com", newPassword), {
      message: "Admin not found",
    });
  });
});

test("password change does not reactivate an inactive admin", async () => {
  await withTestRollback(client, async () => {
    const id = await createAdmin(client, "admin@example.com", password);
    await client.query("UPDATE users SET active = false WHERE id = $1", [id]);
    await changeAdminPassword(client, "admin@example.com", newPassword);
    assert.equal((await client.query("SELECT active FROM users WHERE id = $1", [id])).rows[0].active, false);
  });
});

test("failed session revocation rolls back password change atomically", async () => {
  await withTestRollback(client, async () => {
    const id = await createAdmin(client, "admin@example.com", password);
    await client.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 hour')",
      ["a".repeat(64), id],
    );
    await client.query("ALTER TABLE sessions ADD CONSTRAINT forbid_revocation CHECK (revoked_at IS NULL)");
    await client.query("SAVEPOINT failed_change");
    await assert.rejects(() => changeAdminPassword(client, "admin@example.com", newPassword), { code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT failed_change");
    const user = await client.query("SELECT password_hash FROM users WHERE id = $1", [id]);
    assert.equal(await verifyPassword(password, user.rows[0].password_hash), true);
    assert.equal((await client.query("SELECT revoked_at FROM sessions")).rows[0].revoked_at, null);
  });
});

for (const args of [["create"], ["change-password"], ["create", "synthetic-secret"], ["unknown"]]) {
  test(`admin CLI refuses noninteractive input or unsupported arguments (${args.length} arguments)`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/run-admin.ts", ...args], {
      env: { ...process.env, DATABASE_URL: "" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /synthetic-secret|password_hash|postgresql:\/\//);
    assert.match(result.stderr, /Admin command failed:/);
  });
}
