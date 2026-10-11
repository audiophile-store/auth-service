import { createHash, randomBytes } from "node:crypto";
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from "express";
import type { Pool, QueryResultRow } from "pg";
import { createLoginLimit } from "./login-limit.js";
import { verifyPassword } from "./passwords.js";
import { validateLoginRequest } from "./validation.js";

export type AuthDatabase = Pick<Pool, "query">;
export type AuthOptions = {
  allowedOrigins: string[];
  secureCookies: boolean;
  now?: () => number;
};

class DatabaseUnavailableError extends Error {}

async function query<Row extends QueryResultRow>(database: AuthDatabase | undefined, sql: string, values: unknown[]) {
  if (!database) throw new DatabaseUnavailableError("Auth database is not configured");
  try {
    return await database.query<Row>(sql, values);
  } catch {
    throw new DatabaseUnavailableError("Auth database request failed");
  }
}

const cookieName = "audiophile_session";
const sessionMs = 60 * 60 * 1000;

function tokenFromRequest(req: Request): string | undefined {
  const cookies = (req.headers.cookie ?? "").split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${cookieName}=`));
  return cookies.length === 1 ? cookies[0]?.slice(cookieName.length + 1) : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function errorResponse(res: Response, status: number, error: string, code: string) {
  return res.status(status).json({ error, code });
}

type UserRow = { id: string; email: string; role: string; password_hash: string; active: boolean };
type SessionRow = { id: string; email: string; role: string; expires_at: Date };

export function registerAuth(app: Express, database: AuthDatabase | undefined, options: AuthOptions) {
  for (const origin of options.allowedOrigins) {
    if (!URL.canParse(origin) || !["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) {
      throw new Error("AUTH_ALLOWED_ORIGINS must contain exact HTTP origins without paths");
    }
  }
  const now = options.now ?? Date.now;
  const limiter = createLoginLimit();
  const cookieOptions = {
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: options.secureCookies ? "none" as const : "lax" as const,
    path: "/",
  };

  app.use(["/login", "/me", "/logout"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Origin");
    const origin = req.get("Origin");
    const allowedOrigin = origin !== undefined && options.allowedOrigins.includes(origin);
    if (allowedOrigin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
      const method = req.baseUrl === "/me" ? "GET" : "POST";
      const headers = (req.get("Access-Control-Request-Headers") ?? "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      if (!allowedOrigin || req.get("Access-Control-Request-Method") !== method ||
        headers.some((header) => header !== "content-type")) {
        return errorResponse(res, 403, "Forbidden preflight", "FORBIDDEN_PREFLIGHT");
      }
      res.set("Access-Control-Allow-Methods", method);
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).end();
    }
    if (req.method === "POST" && !allowedOrigin) {
      return errorResponse(res, 403, "Forbidden origin", "FORBIDDEN_ORIGIN");
    }
    next();
  });

  app.post("/login", express.json({ limit: 4096, inflate: false }), async (req, res) => {
    let credentials: { email: string; password: string };
    try {
      credentials = validateLoginRequest(req.body);
    } catch {
      return errorResponse(res, 400, "Invalid login request", "INVALID_BODY");
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const retryAfter = limiter.check(ip, credentials.email, now());
    if (retryAfter) {
      res.set("Retry-After", String(retryAfter));
      return errorResponse(res, 429, "Too many login attempts", "LOGIN_RATE_LIMITED");
    }
    const users = await query<UserRow>(database,
      "SELECT id, email, role, password_hash, active FROM users WHERE email = $1",
      [credentials.email],
    );
    const user = users.rows[0];
    if (!user?.active || user.role !== "admin" || !await verifyPassword(credentials.password, user.password_hash)) {
      limiter.fail(ip, credentials.email, now());
      return errorResponse(res, 401, "Invalid credentials", "INVALID_CREDENTIALS");
    }
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date(now());
    const expiresAt = new Date(createdAt.getTime() + sessionMs);
    await query(database,
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [tokenHash(token), user.id, createdAt, expiresAt],
    );
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMs });
    res.json({ user: { id: user.id, email: user.email, role: user.role }, expiresAt: expiresAt.toISOString() });
  });

  app.get("/me", async (req, res) => {
    const token = tokenFromRequest(req);
    if (!token) return errorResponse(res, 401, "Invalid session", "INVALID_SESSION");
    const sessions = await query<SessionRow>(database,
      `SELECT users.id, users.email, users.role, sessions.expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2 AND users.active AND users.role = 'admin'`,
      [tokenHash(token), new Date(now())],
    );
    const session = sessions.rows[0];
    if (!session) return errorResponse(res, 401, "Invalid session", "INVALID_SESSION");
    res.json({ user: { id: session.id, email: session.email, role: session.role }, expiresAt: session.expires_at.toISOString() });
  });

  app.post("/logout", async (req, res) => {
    const token = tokenFromRequest(req);
    if (token) {
      await query(database,
        "UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
        [tokenHash(token), new Date(now())],
      );
    }
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof DatabaseUnavailableError) {
      console.error("Auth database request failed");
      errorResponse(res, 503, "Service unavailable", "SERVICE_UNAVAILABLE");
      return;
    }
    if (typeof error === "object" && error !== null && "type" in error &&
      ["entity.parse.failed", "entity.too.large", "encoding.unsupported", "charset.unsupported", "request.aborted", "request.size.invalid"].includes(String(error.type))) {
      errorResponse(res, 400, "Invalid login request", "INVALID_BODY");
      return;
    }
    console.error("Unexpected auth error");
    errorResponse(res, 500, "Internal server error", "INTERNAL_ERROR");
  };
  app.use(handleError);
}
