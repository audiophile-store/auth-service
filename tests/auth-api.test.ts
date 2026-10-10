import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { createApp } from "../src/app.js";
import { changeAdminPassword, createAdmin } from "../src/admin.js";
import { openTestDatabase, withTestRollback } from "./test-database.js";

let client: Client;
const origin = "https://store.example.com";
const email = "admin@example.com";
const password = "Synthetic-Login-Password!";
const initialTime = Date.parse("2026-10-10T12:00:00Z");

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

async function withApi(run: (
  request: (path: string, init?: RequestInit) => Promise<Response>,
  setTime: (time: number) => void,
) => Promise<void>, secureCookies = true) {
  await withTestRollback(client, async () => {
    await createAdmin(client, email, password);
    let time = initialTime;
    const server = createApp(client, {
      allowedOrigins: [origin],
      secureCookies,
      now: () => time,
    }).listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await run(
        (path, init) => fetch(`http://127.0.0.1:${address.port}${path}`, init),
        (value) => { time = value; },
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

function loginBody(loginEmail = email, loginPassword = password): RequestInit {
  return {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  };
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header.split(";")[0] ?? "";
}

test("login returns identity and exact one-hour expiry, stores only token hash and sets secure cookie", async () => {
  await withApi(async (request) => {
    const response = await request("/login", loginBody(" ADMIN@EXAMPLE.COM "));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "user"]);
    assert.deepEqual(Object.keys(body.user).sort(), ["email", "id", "role"]);
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, "admin");
    assert.equal(body.expiresAt, "2026-10-10T13:00:00.000Z");
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=3600"]) {
      assert.ok(cookie.includes(attribute), attribute);
    }
    assert.doesNotMatch(cookie, /Domain=/i);
    const token = sessionCookie(response).split("=")[1];
    assert.ok(token);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.equal(JSON.stringify(body).includes(token), false);
    const sessions = await client.query("SELECT * FROM sessions");
    assert.equal(sessions.rowCount, 1);
    assert.equal(sessions.rows[0].token_hash, createHash("sha256").update(token).digest("hex"));
    assert.deepEqual(sessions.rows[0].created_at, new Date(initialTime));
    assert.deepEqual(sessions.rows[0].expires_at, new Date(initialTime + 3600000));
    assert.equal(sessions.rows[0].revoked_at, null);
  });
});

test("local HTTP cookie omits Secure while retaining HttpOnly and SameSite", async () => {
  await withApi(async (request) => {
    const response = await request("/login", loginBody());
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /Secure/i);
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  }, false);
});

test("wrong password and unknown email return identical non-disclosing errors", async () => {
  await withApi(async (request) => {
    const wrong = await request("/login", loginBody(email, "Wrong-Password!"));
    const unknown = await request("/login", loginBody("missing@example.com"));
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    assert.equal(wrong.headers.get("set-cookie"), null);
    assert.equal((await client.query("SELECT * FROM sessions")).rowCount, 0);
  });
});

test("inactive admin cannot login or use an existing session", async () => {
  await withApi(async (request) => {
    const cookie = sessionCookie(await request("/login", loginBody()));
    await client.query("UPDATE users SET active = false WHERE email = $1", [email]);
    assert.equal((await request("/me", { headers: { cookie } })).status, 401);
    assert.equal((await request("/login", loginBody())).status, 401);
  });
});

for (const suppliedOrigin of [undefined, "null", "https://evil.example", `${origin}.evil.example`]) {
  test(`login and logout reject forbidden or missing Origin (${suppliedOrigin ?? "missing"})`, async () => {
    await withApi(async (request) => {
      for (const path of ["/login", "/logout"]) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (suppliedOrigin !== undefined) headers.origin = suppliedOrigin;
        const response = await request(path, { method: "POST", headers, body: "{}" });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("set-cookie"), null);
      }
      assert.equal((await client.query("SELECT * FROM sessions")).rowCount, 0);
    });
  });
}

test("me needs no Origin, does not extend expiry, and rejects the exact expiry boundary", async () => {
  await withApi(async (request, setTime) => {
    const login = await request("/login", loginBody());
    const body = await login.json();
    const cookie = sessionCookie(login);
    setTime(initialTime + 3599999);
    const me = await request("/me", { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), body);
    assert.equal(me.headers.get("set-cookie"), null);
    assert.equal(me.headers.get("cache-control"), "no-store");
    setTime(initialTime + 3600000);
    assert.equal((await request("/me", { headers: { cookie } })).status, 401);
    const sessions = await client.query("SELECT expires_at FROM sessions");
    assert.deepEqual(sessions.rows[0].expires_at, new Date(initialTime + 3600000));
  });
});

for (const cookie of ["", "other=value", "audiophile_session=invalid", `audiophile_session=${"a".repeat(43)}`]) {
  test("me rejects missing, malformed or unknown session", async () => {
    await withApi(async (request) => {
      const response = await request("/me", { headers: { cookie } });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
    });
  });
}

test("duplicate session cookies cannot authenticate", async () => {
  await withApi(async (request) => {
    const cookie = sessionCookie(await request("/login", loginBody()));
    assert.equal((await request("/me", { headers: { cookie: `${cookie}; ${cookie}` } })).status, 401);
  });
});

test("logout revokes only the current session and clears cookie; repeated logout is allowed", async () => {
  await withApi(async (request) => {
    const first = sessionCookie(await request("/login", loginBody()));
    const second = sessionCookie(await request("/login", loginBody()));
    const logout = await request("/logout", { method: "POST", headers: { origin, cookie: first } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /audiophile_session=;/);
    assert.match(logout.headers.get("set-cookie") ?? "", /Expires=Thu, 01 Jan 1970/);
    assert.equal(logout.headers.get("cache-control"), "no-store");
    assert.equal((await request("/me", { headers: { cookie: first } })).status, 401);
    assert.equal((await request("/me", { headers: { cookie: second } })).status, 200);
    assert.equal((await request("/logout", { method: "POST", headers: { origin, cookie: first } })).status, 204);
  });
});

test("logout clears missing or expired cookie without requiring active session", async () => {
  await withApi(async (request, setTime) => {
    const cookie = sessionCookie(await request("/login", loginBody()));
    setTime(initialTime + 3600000);
    for (const value of ["", cookie]) {
      const response = await request("/logout", { method: "POST", headers: { origin, cookie: value } });
      assert.equal(response.status, 204);
      assert.ok(response.headers.get("set-cookie"));
    }
  });
});

test("password change invalidates all existing sessions and accepts only the new password", async () => {
  await withApi(async (request) => {
    const first = sessionCookie(await request("/login", loginBody()));
    const second = sessionCookie(await request("/login", loginBody()));
    await changeAdminPassword(client, email, "Updated-Password!");
    for (const cookie of [first, second]) {
      assert.equal((await request("/me", { headers: { cookie } })).status, 401);
    }
    assert.equal((await request("/login", loginBody())).status, 401);
    assert.equal((await request("/login", loginBody(email, "Updated-Password!"))).status, 200);
  });
});

test("five failed attempts block IP/email pair until exactly fifteen minutes", async () => {
  await withApi(async (request, setTime) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await request("/login", loginBody(email, "Wrong!"))).status, 401);
    }
    const blocked = await request("/login", loginBody());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "900");
    assert.equal((await request("/login", loginBody("different@example.com"))).status, 401);
    setTime(initialTime + 900000);
    assert.equal((await request("/login", loginBody())).status, 200);
  });
});

test("thirty attempts block the IP, even with varied emails and forged forwarded headers", async () => {
  await withApi(async (request) => {
    for (let i = 0; i < 30; i++) {
      const init = loginBody(`missing${i}@example.com`);
      init.headers = { ...init.headers, "x-forwarded-for": `192.0.2.${i + 1}` };
      assert.equal((await request("/login", init)).status, 401);
    }
    assert.equal((await request("/login", loginBody())).status, 429);
  });
});

for (const [name, body] of [
  ["malformed JSON", "{"],
  ["array", "[]"],
  ["missing fields", "{}"],
  ["extra fields", JSON.stringify({ email, password, role: "admin" })],
]) {
  test(`login rejects ${name} with generic 400`, async () => {
    await withApi(async (request) => {
      const response = await request("/login", {
        method: "POST", headers: { origin, "content-type": "application/json" }, body,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(Object.keys(await response.json()).sort(), ["code", "error"]);
    });
  });
}

test("login allows exactly 4096 body bytes and rejects 4097", async () => {
  await withApi(async (request) => {
    const json = JSON.stringify({ email, password });
    for (const [length, status] of [[4096, 200], [4097, 400]]) {
      const body = json + " ".repeat(length - Buffer.byteLength(json));
      assert.equal(Buffer.byteLength(body), length);
      const response = await request("/login", {
        method: "POST", headers: { origin, "content-type": "application/json" }, body,
      });
      assert.equal(response.status, status);
    }
  });
});

test("non-JSON login is rejected", async () => {
  await withApi(async (request) => {
    assert.equal((await request("/login", {
      method: "POST", headers: { origin, "content-type": "text/plain" }, body: "secret",
    })).status, 400);
  });
});

test("database errors deny login, me and logout without success or cookie changes", async () => {
  await withApi(async (request) => {
    const cookie = sessionCookie(await request("/login", loginBody()));
    await client.query("SAVEPOINT missing_sessions");
    await client.query("DROP TABLE sessions");
    try {
      for (const [path, init] of [
        ["/login", loginBody()],
        ["/me", { headers: { cookie } }],
        ["/logout", { method: "POST", headers: { origin, cookie } }],
      ] satisfies Array<[string, RequestInit]>) {
        await client.query("SAVEPOINT failed_request");
        const response = await request(path, init);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.deepEqual(await response.json(), { error: "Service unavailable", code: "SERVICE_UNAVAILABLE" });
        await client.query("ROLLBACK TO SAVEPOINT failed_request");
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT missing_sessions");
    }
  });
});

test("invalid stored password hash gives 500, not successful login or a false 401", async () => {
  await withApi(async (request) => {
    await client.query("UPDATE users SET password_hash = 'broken' WHERE email = $1", [email]);
    const response = await request("/login", loginBody());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error", code: "INTERNAL_ERROR" });
    assert.equal(response.headers.get("set-cookie"), null);
  });
});

test("sessions survive application recreation", async () => {
  await withApi(async (request) => {
    const cookie = sessionCookie(await request("/login", loginBody()));
    const server = createApp(client, { allowedOrigins: [origin], secureCookies: true, now: () => initialTime }).listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/me`, { headers: { cookie } });
      assert.equal(response.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
