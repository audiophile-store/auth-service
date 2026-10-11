# auth-service

## Docker

The multi-stage image builds the TypeScript application with Node.js 22 and
includes only compiled output and production dependencies in the runtime stage.
The server runs as the non-root `node` user. Source files, local environment files,
and project context are not copied into the image.

The Docker setup follows the products service pattern: the runtime stage
upgrades installed Debian packages and removes npm/npx after installing
production dependencies. The container starts directly with Node.js.
The `.dockerignore` excludes local dependencies, build output, environment
files, Git metadata, and project context from the build context. Tests are
available to the test stage only and are not copied into the runtime image.

Build locally:

```sh
docker build -t audiophile-auth-service:local .
```

Use Compose below to provide the database configuration and start the server.
Check the running process:

```sh
curl --fail http://127.0.0.1:3002/health
```

Expected response: `{"status":"ok"}`.
The image defaults to port 3000; override `PORT` with `docker run -e PORT=...`
and adjust the container port mapping accordingly.

## Local Compose

Copy `.env.example` to `.env` and replace the database password placeholder
with your own local value. Do not commit `.env`. Compose requires nonempty
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Configure the three
connection URLs with the same credentials: `DATABASE_URL` uses localhost port
5434 and database `auth`, `DOCKER_DATABASE_URL` uses host `db` port 5432 and
database `auth`, and `TEST_DATABASE_URL` uses localhost port 5434 and database
`auth_test`. URL-encode username/password characters when necessary; never
paste credentials into chat or command-line arguments.

First start only PostgreSQL, then explicitly apply the development migration
and create the separate test database:

```sh
docker compose config --quiet
docker compose up -d --wait db
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' < migrations/001_create_auth.sql
docker compose exec db sh -c 'createdb -U "$POSTGRES_USER" auth_test'
docker compose up --build -d --wait
docker compose ps
curl --fail http://127.0.0.1:3002/health
```

Auth uses localhost port 3002 and PostgreSQL uses localhost port 5434 by default,
avoiding the products and orders service ports. Override `PORT` or
`POSTGRES_PORT` in `.env` if needed. Inside the app container, the server listens
on port 3000. Compose waits for the database health check before starting the app.
The application requires `DATABASE_URL` and successfully queries the database
before listening. Connection failures are logged without private details and
prevent startup; the pool's connection timeout is two seconds. After startup,
`/health` remains a process liveness check, not a database readiness check.
Compose passes `DOCKER_DATABASE_URL` to the app as `DATABASE_URL`. Leaving it
empty keeps database-only commands usable, but the app exits with an explicit
required-configuration error.

Inspect the database without putting the password in command-line arguments:

```sh
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

PostgreSQL data lives in the project-scoped `auth_db_data` named volume and
survives container recreation. Stop and remove containers with
`docker compose down`; do not add `--volumes` if you want to keep your data.
Database initialization variables apply only to an empty volume; changing
them later does not change existing accounts or passwords.

The initial migration must be applied once to a fresh database. It creates
`users` with a unique email, password hash, admin role, activity flag and creation
time, and `sessions` with a unique SHA-256 token hash, user reference, timestamps
and nullable revocation time. It does not create an admin or implement login,
password hashing, or session operations.

No migration, admin account, or test database is created automatically.
Do not reapply the initial migration to existing tables. PostgreSQL and test
database setup here are local only; Supabase is not configured.

## Development and tests

Run `npm run dev` for the local server or `npm run build` then `npm start`
with `DATABASE_URL` supplied by the environment. `npm run test:local` loads
the local `.env`; `npm test` uses supplied environment variables, as in CI.
Database tests require the exact database name `auth_test` and check the
connected database before creating transaction-scoped random schemas. Each
schema receives the migration and is rolled back after tests, leaving public
tables and development data untouched. Do not use the development or a
production database for tests.

To run all tests in Docker instead of installing development dependencies on
your computer:

```sh
docker compose --profile test run --build --rm test
```

The separate `test` build stage includes development dependencies, tests, and
the migration, and runs as the non-root user. The production runtime remains
unchanged and excludes these files. The test service uses a profile so normal
`docker compose up` does not run tests. Create `auth_test` once using the command
above before running this service.

The Docker test runner takes credentials and the database name from
`TEST_DATABASE_URL`, rejects any database name other than `auth_test`, and changes
only the host/port to `db:5432` for the Compose network. You can keep the same
localhost URL for tests on your computer. No local `.env` is copied into the
image. Failed tests produce a nonzero container exit code; `--rm` removes the
one-off test container without removing the database or its volume.

## Password hashing

`hashPassword(password)` and `verifyPassword(password, passwordHash)` in
`src/passwords.ts` use the `argon2` library and Argon2id with 64 MiB memory
(`memoryCost: 65536` KiB), three iterations, and parallelism one. The library
generates a fresh cryptographic salt for each hash; the encoded hash includes
the algorithm, parameters, salt, and result, and can be stored in `password_hash`.

Correct passwords return `true` and incorrect passwords return `false`.
Invalid stored hashes and library errors propagate as errors, not authentication
failures. Passwords are not trimmed or normalized and are never logged.
Password policy and admin commands use separate helpers described below;
hashing itself does not access a database or create accounts. Login integration
remains a later step.

## Input validation

`src/validation.ts` provides standalone helpers; no HTTP routes are added.
`validateEmail` trims and lowercases an email, enforces a 254-character limit,
and accepts unquoted dot-separated local parts and dotted domain names.
Display names, whitespace inside addresses, empty labels, and domain labels
with leading/trailing hyphens are rejected.

`validateNewPassword` preserves the original password and requires 8–128
Unicode code points, at least one uppercase letter, and punctuation or a symbol.
Whitespace does not count as a special character; digits and lowercase letters
are not mandatory. This policy is intended for account creation/password changes.

`validateLoginRequest` accepts only `email` and `password`, returns a fresh object
with normalized email and unchanged password, and requires a nonempty password
of at most 128 Unicode code points without imposing new-password complexity.
Validation errors use fixed messages without input values and propagate to the
caller. The 4 KiB HTTP body limit will be wired when login is implemented.

## Admin commands

After explicitly applying the migration, run one of these commands from an
interactive terminal:

```sh
npm run admin:create
npm run admin:change-password
```

They load the local `.env` and connect through `DATABASE_URL`. Email is prompted;
password and confirmation are entered without terminal echo. Passwords must
match and pass the new-password policy. Never pass a password as a command-line
argument, environment variable, seed file, or chat message. Noninteractive input
and additional arguments are rejected; cancellation and errors return a nonzero
exit code without printing credentials or database details.

To use the running local Docker app instead:

```sh
docker compose exec app node dist/run-admin.js create
docker compose exec app node dist/run-admin.js change-password
```

Rebuild the app container first after code changes. These commands use the
container's configured database; they do not need npm in the production image.
Check the target database before running them. Production commands require a
separately authorized interactive environment and the production configuration.

Creation stores a normalized unique email, an Argon2id hash and the admin role;
duplicate email errors do not overwrite an account. Password changes update
the hash and revoke all non-revoked sessions for that admin atomically in one
SQL statement. They preserve previously recorded revocation times and account
activity, and do not modify other accounts. No public registration or password
change endpoint is provided, and no admin is created at server startup.

## Authentication routes

| Route | Result |
| --- | --- |
| `POST /login` | Validates JSON email/password, verifies the admin, saves a session, and returns `{ user: { id, email, role }, expiresAt }`. |
| `GET /me` | Returns the same identity/expiry for an active session, otherwise 401; never extends its lifetime. |
| `POST /logout` | Revokes only the current session and clears the cookie; returns 204, including for an expired/missing session. |

Sessions expire one hour after login. A random 32-byte token is sent only in
the `audiophile_session` cookie; PostgreSQL stores its SHA-256 hash. Cookies
use HttpOnly, Path=/ and no Domain. Production cookies use `SameSite=None; Secure`
so the HTTPS frontend can use a session on a different site. With
`NODE_ENV=development`, local HTTP cookies use `SameSite=Lax` without Secure.
Login and logout clear/set cookies with the same attributes.
Auth responses have `Cache-Control: no-store`.

Set `AUTH_ALLOWED_ORIGINS` to comma-separated exact UI origins (no trailing
slash). Login/logout require a matching Origin header; `/me` works without it
for backend callers. An empty allowlist denies login/logout and produces a
startup warning. Compose uses development mode by default for local HTTP;
Render must retain production mode and its explicit approved UI origins.
The same direct API integration is used locally and in production; no frontend
proxy is needed. Auth routes return credentialed CORS headers only for exact
allowlisted origins, including error responses, and handle JSON preflights
without accessing the database. Preflights allow GET for `/me`, POST for
`/login` and `/logout`, and the Content-Type header. Other origins, methods
and headers are rejected.

Locally, use `http://localhost:5173` consistently in the browser and
`VITE_AUTH_API_URL=http://localhost:3002` in the webshop. `127.0.0.1` is a
different origin and site; do not mix it with localhost for local cookies.
In production, set the webshop's `VITE_AUTH_API_URL` to the public HTTPS auth
base URL, configure `AUTH_ALLOWED_ORIGINS` with the exact HTTPS webshop origin,
and retain `NODE_ENV=production`. Rebuild/redeploy both applications after
changing their configuration. Browser third-party cookie restrictions can
still block cross-site sessions; use same-site HTTPS domains if required.

### Production environment variables

On Render, configure the auth service:

| Variable | Value |
| --- | --- |
| `AUTH_ALLOWED_ORIGINS` | `https://audiophile-store-beryl.vercel.app`, or the exact frontend origin you use, without a trailing slash. |
| `DATABASE_URL` | Keep the existing production database connection string private. |
| `NODE_ENV` | `production` (already the default in the Docker runtime image). |

On Vercel, configure the webshop's Production environment with
`VITE_AUTH_API_URL` set to the auth service's public HTTPS base URL, without an
endpoint such as `/login`. No additional CORS or cookie variables are required.
Deploy the updated auth code on Render; environment changes alone do not add
CORS support to an older image. Redeploy the webshop if its API URL changed
since the last build. Preview origins must be explicitly allowlisted and use
the corresponding Vercel environment configuration; production settings do
not automatically cover preview deployments.

The in-memory limiter allows 30 login attempts per IP and five failed attempts
per IP/email in a 15-minute fixed window. It resets on restart and is intended
for one instance; malformed/invalid input is rejected before counting.
Express does not trust forwarded IP headers. Proxy/client-IP
verification on Render remains pending; clients behind a proxy may share a limit.

Invalid input (including JSON over 4096 bytes) returns 400, invalid credentials
or session 401, forbidden Origin 403, rate limit 429 with Retry-After, database
errors 503, and unexpected errors 500. Errors contain `error` and `code`, not
credentials or database details. Failed login/logout database writes do not
return success or change cookies.

This deliberately simple demo does not equalize unknown-email verification
timing or reserve limiter slots for concurrent password checks. Account changes
and login are intended as sequential demo operations; concurrent login/password
changes are not serialized. Database persistence and existing session
revocation remain covered by tests. Browser/proxy behavior still needs separate
verification during UI integration.

## Deployment configuration boundary

The database-enabled startup requires a reachable `DATABASE_URL` on Render.
Production PostgreSQL is hosted on Neon; use the Neon connection string with
its SSL parameters intact, not a local `localhost`/`db` URL. Store it only in
Render environment settings. Apply the migration explicitly in the Neon SQL
Editor, in a transaction, before deploying code that uses these tables.
Database creation and migration are not part of automatic deployment.

The production database and migration were reported configured by the owner;
the deployed database-enabled application's connection still needs verification
after merge and successful CI/deployment. No admin account is created yet.

## Continuous integration

The `CI` workflow in `.github/workflows/ci.yml` runs on pull requests targeting
`main` and pushes to `main`. On Node.js 22 it installs locked dependencies,
then runs lint, the TypeScript build, and tests against a fresh PostgreSQL 16
`auth_test` database. Tests apply the migration in isolated transactional schemas.
The database exists only for the checks job, and its fixed credentials are
disposable CI values, not local or production secrets.

Only after these checks pass, a second job builds the Docker image with a
refreshed base image and tags it with the commit SHA. Trivy 0.75.0 reports all
vulnerability severities, including findings without fixes. A separate step
rejects fixable HIGH/CRITICAL findings; scanner errors also fail the job.
This follows the products service's scanning policy.

Actions are pinned to full commit SHAs, repository permissions are read-only,
and checkout does not persist credentials. The workflow does not load `.env`,
access production databases, publish images, or deploy. Required checks and
branch protection must be configured separately after an authorized GitHub run.