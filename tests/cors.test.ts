import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";

const origins = ["http://localhost:5173", "https://store.example.com"];

async function withApi(run: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>) {
  const server = createApp(undefined, { allowedOrigins: origins, secureCookies: true })
    .listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run((path, init) => fetch(`http://127.0.0.1:${address.port}${path}`, init));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function assertCors(response: Response, origin: string) {
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.match(response.headers.get("vary") ?? "", /Origin/);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

for (const origin of origins) {
  test(`credentialed CORS and JSON preflight work for ${origin}`, async () => {
    await withApi(async (request) => {
      for (const [path, method] of [["/login", "POST"], ["/me", "GET"], ["/logout", "POST"]]) {
        const preflight = await request(path, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": method,
            "access-control-request-headers": "Content-Type",
          },
        });
        assert.equal(preflight.status, 204);
        assertCors(preflight, origin);
        assert.equal(preflight.headers.get("access-control-allow-methods"), method);
        assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");
        assert.equal(preflight.headers.get("set-cookie"), null);
      }
      const me = await request("/me", { headers: { origin } });
      assert.equal(me.status, 401);
      assertCors(me, origin);
      const login = await request("/login", {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
      });
      assert.equal(login.status, 400);
      assertCors(login, origin);
      const unavailable = await request("/login", {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "Synthetic-Password!" }),
      });
      assert.equal(unavailable.status, 503);
      assertCors(unavailable, origin);
      const logout = await request("/logout", { method: "POST", headers: { origin } });
      assert.equal(logout.status, 204);
      assertCors(logout, origin);
    });
  });
}

test("preflights reject missing, null, lookalike and unapproved origins without granting CORS", async () => {
  await withApi(async (request) => {
    for (const origin of [undefined, "null", "https://store.example.com.evil.example", "http://127.0.0.1:5173"]) {
      for (const path of ["/login", "/me", "/logout"]) {
        const headers: Record<string, string> = { "access-control-request-method": path === "/me" ? "GET" : "POST" };
        if (origin !== undefined) headers.origin = origin;
        const response = await request(path, { method: "OPTIONS", headers });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
        assert.equal(response.headers.get("set-cookie"), null);
      }
    }
    const me = await request("/me", { headers: { origin: "https://evil.example" } });
    assert.equal(me.status, 401);
    assert.equal(me.headers.get("access-control-allow-origin"), null);
  });
});

test("preflight validates route methods and requested headers, and permits simple requests", async () => {
  await withApi(async (request) => {
    for (const [path, method, headers] of [
      ["/login", "DELETE", "content-type"],
      ["/me", "POST", ""],
      ["/logout", "GET", ""],
      ["/login", "POST", "content-type, authorization"],
      ["/login", "", ""],
    ]) {
      const response = await request(path, {
        method: "OPTIONS",
        headers: {
          origin: origins[0],
          "access-control-request-method": method,
          "access-control-request-headers": headers,
        },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-methods"), null);
    }
    const response = await request("/logout", {
      method: "OPTIONS", headers: { origin: origins[0], "access-control-request-method": "POST" },
    });
    assert.equal(response.status, 204);
    assertCors(response, origins[0]);
  });
});
