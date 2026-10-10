import { spawnSync } from "node:child_process";

const configuredUrl = process.env.TEST_DATABASE_URL;
if (!configuredUrl || !URL.canParse(configuredUrl)) {
  throw new Error("A valid TEST_DATABASE_URL is required for Docker tests");
}

const url = new URL(configuredUrl);
if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/auth_test") {
  throw new Error("Docker tests require a PostgreSQL auth_test database");
}
url.hostname = "db";
url.port = "5432";

const result = spawnSync("npm", ["test"], {
  env: { ...process.env, TEST_DATABASE_URL: url.toString() },
  stdio: "inherit",
});
if (result.error) {
  throw new Error("Unable to start Docker tests", { cause: result.error });
}
process.exitCode = result.status ?? 1;
