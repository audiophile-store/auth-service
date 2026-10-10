import express from "express";
import { type AuthDatabase, type AuthOptions, registerAuth } from "./auth.js";

export function createApp(
  database?: AuthDatabase,
  options: AuthOptions = { allowedOrigins: [], secureCookies: true },
) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  registerAuth(app, database, options);

  return app;
}
