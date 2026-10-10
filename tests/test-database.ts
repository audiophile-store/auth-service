import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

export async function openTestDatabase() {
  const migration = await readFile(
    new URL("../migrations/001_create_auth.sql", import.meta.url),
    "utf8",
  );
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "Set TEST_DATABASE_URL to an isolated auth_test database");
  assert.equal(new URL(url).pathname, "/auth_test", "Database tests require auth_test");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>("SELECT current_database() AS name");
    assert.equal(result.rows[0]?.name, "auth_test");
    await client.query("BEGIN");
    const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(migration);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

export async function withTestRollback(client: Client, run: () => Promise<void>) {
  await client.query("SAVEPOINT test_case");
  try {
    await run();
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT test_case");
    await client.query("RELEASE SAVEPOINT test_case");
  }
}
