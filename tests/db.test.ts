import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runPool(script: string, databaseUrl = "") {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl, AUTH_ALLOWED_ORIGINS: "https://store.example.com" },
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("pool requires DATABASE_URL without default credentials", () => {
  const result = runPool('await import("./src/db.js");');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("pool uses the configured URL and does not connect on import", () => {
  const result = runPool(`
    import assert from "node:assert/strict";
    const { pool } = await import("./src/db.js");
    assert.equal(pool.options.connectionString, process.env.DATABASE_URL);
    assert.equal(pool.options.connectionTimeoutMillis, 2000);
    assert.equal(pool.totalCount, 0);
    await pool.end();
  `, "postgresql://localhost:5434/auth_test");
  assert.equal(result.status, 0, result.stderr);
});

test("pool logs idle errors without private connection details", () => {
  const result = runPool(`
    const { pool } = await import("./src/db.js");
    pool.emit("error", new Error("private connection details"));
    await pool.end();
  `, "postgresql://localhost:5434/auth_test");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), "Database connection error");
});

test("database test helper refuses development and products databases", () => {
  for (const name of ["auth", "products", "products_test", "orders_test"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        const { openTestDatabase } = await import("./tests/test-database.js");
        await assert.rejects(openTestDatabase, /Database tests require auth_test/);
      `],
      {
        env: { ...process.env, TEST_DATABASE_URL: `postgresql://localhost:1/${name}` },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test("startup fails explicitly without leaking credentials when the database is unavailable", () => {
  const result = runPool(
    'await import("./src/index.js");',
    "postgresql://auth:synthetic-private-password@127.0.0.1:1/auth_test",
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "Unable to start auth service: database connection failed");
});

test("pool connects only to the configured auth test database", () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "Set TEST_DATABASE_URL to an isolated auth_test database");
  assert.equal(new URL(url).pathname, "/auth_test", "Database tests require auth_test");
  const result = runPool(`
    import assert from "node:assert/strict";
    const { pool } = await import("./src/db.js");
    try {
      const result = await pool.query("SELECT current_database() AS name");
      assert.equal(result.rows[0].name, "auth_test");
    } finally {
      await pool.end();
    }
  `, url);
  assert.equal(result.status, 0, "Auth test database connection failed");
});
