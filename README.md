# Audiophile Auth Service

The administrator authentication backend for the Audiophile portfolio project.
It verifies credentials and manages cookie-based sessions stored in PostgreSQL.

**[Live webshop](https://audiophile-store-beryl.vercel.app/)** ·
**[Frontend code](https://github.com/audiophile-store/webshop)**

**Admin demo access:** Contact [Stefan Rakonjac](https://github.com/xarambash)
to request private credentials for the [admin area](https://audiophile-store-beryl.vercel.app/admin).
No credentials are published in this repository.

## Highlights

- Administrator login, session restoration and logout.
- Argon2id password hashing and hashed session tokens in PostgreSQL.
- One-hour HttpOnly cookie sessions, without tokens in browser localStorage.
- Exact-origin credentialed CORS and JSON preflight support.
- Login rate limiting and session revocation after password changes.
- Interactive tools for creating admins and changing passwords.
- Unit, database and API integration tests with GitHub Actions checks.

**Tech stack:** TypeScript, Node.js, Express, PostgreSQL, Argon2, Docker and Biome.
The backend is hosted on Render.

**Demo scope:** Administrators only; no public registration, password reset or
profile API. The frontend's product create/edit/delete controls are UI-only.
A protected frontend route does not replace backend authorization.

## API overview

| Endpoint       | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `POST /login`  | Validate `{ email, password }`, set a cookie and return identity/expiry |
| `GET /me`      | Restore an active session; otherwise HTTP 401                           |
| `POST /logout` | Revoke the session and clear its cookie; HTTP 204                       |
| `GET /health`  | Process liveness, not database readiness                                |

Login/logout require an allowlisted Origin header. Auth responses disable caching.
Local HTTP cookies use `SameSite=Lax`; production uses `SameSite=None; Secure`.
Browser third-party cookie restrictions can still block cross-site sessions.

## Run locally

Use Node.js 22 and Docker Compose. Copy `.env.example` to `.env` and replace the
database password placeholders in all URLs. `DATABASE_URL` uses localhost port 5434;
`DOCKER_DATABASE_URL` uses `db:5432`, with the same credentials.
Do not commit `.env` or credentials.

For a fresh database:

```bash
npm install
docker compose up -d --wait db
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' < migrations/001_create_auth.sql
npm run admin:create
npm run dev
```

The API runs at `http://localhost:3002`. Apply the migration only once.
Admin credentials are prompted interactively without echoing passwords; no
account is created automatically. `npm run admin:change-password` updates a
password and revokes that admin's sessions.
After database setup, use `docker compose up --build -d --wait` instead of
the development server. Container admin tooling is available through
`docker compose exec app node dist/run-admin.js create`.

| Variable               | Local                      | Production on Render                             |
| ---------------------- | -------------------------- | ------------------------------------------------ |
| `DATABASE_URL`         | Local PostgreSQL URL       | Production PostgreSQL URL                        |
| `AUTH_ALLOWED_ORIGINS` | `http://localhost:5173`    | Exact HTTPS webshop origin, without trailing `/` |
| `NODE_ENV`             | `development`              | `production` (Docker runtime default)            |
| `PORT`                 | `3002` for npm development | Host-supplied; Docker defaults to `3000`         |

Allowed origins are comma-separated; an empty allowlist denies login/logout.
Open the local UI at `http://localhost:5173`, not `127.0.0.1`, to avoid mixing cookie sites.
On Vercel, set `VITE_AUTH_API_URL` to the public HTTPS auth base URL, without `/login`.
The same direct API integration is used locally and in production; no proxy is needed.

## Quality checks

`npm run lint`, `npm run build` and `npm run test:local`.
Database tests require a separate `auth_test` database via `TEST_DATABASE_URL`.
Create it once with
`docker compose exec db sh -c 'createdb -U "$POSTGRES_USER" auth_test'`.
Tests apply migrations in isolated schemas and roll back changes.
CI runs the checks and builds/scans the Docker image without deploying.

## Related services

[Products](https://github.com/audiophile-store/products-service) ·
[Orders](https://github.com/audiophile-store/orders-service)

## Author

Stefan Rakonjac — [@xarambash](https://github.com/xarambash)
