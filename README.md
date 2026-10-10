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
files, tests, Git metadata, and project context from the build context.

Build and start locally:

```sh
docker build -t audiophile-auth-service:local .
docker run --rm --name audiophile-auth-local -p 127.0.0.1:3000:3000 audiophile-auth-service:local
```

From another terminal, check the running process:

```sh
curl --fail http://127.0.0.1:3000/health
```

Expected response: `{"status":"ok"}`. Stop the container with Ctrl+C.
The image defaults to port 3000; override `PORT` with `docker run -e PORT=...`
and adjust the container port mapping accordingly.

## Local Compose

Copy `.env.example` to `.env` and replace the database password placeholder
with your own local value. Do not commit `.env`. Compose requires nonempty
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:3002/health
```

Auth uses localhost port 3002 and PostgreSQL uses localhost port 5434 by default,
avoiding the products and orders service ports. Override `PORT` or
`POSTGRES_PORT` in `.env` if needed. Inside the app container, the server listens
on port 3000. Compose waits for the database health check before starting the app,
but the application does not yet connect to the database.

Inspect the database without putting the password in command-line arguments:

```sh
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

PostgreSQL data lives in the project-scoped `auth_db_data` named volume and
survives container recreation. Stop and remove containers with
`docker compose down`; do not add `--volumes` if you want to keep your data.
Database initialization variables apply only to an empty volume; changing
them later does not change existing accounts or passwords.

No migration, admin account, or test database is created automatically.
Database wiring and deployment remain separate upcoming steps.

## Continuous integration

The `CI` workflow in `.github/workflows/ci.yml` runs on pull requests targeting
`main` and pushes to `main`. On Node.js 22 it installs locked dependencies,
then runs lint, the TypeScript build, and the existing tests. No database
service is needed yet; a separate fresh auth test database will be added when
database tests are introduced.

Only after these checks pass, a second job builds the Docker image with a
refreshed base image and tags it with the commit SHA. Trivy 0.75.0 reports all
vulnerability severities, including findings without fixes. A separate step
rejects fixable HIGH/CRITICAL findings; scanner errors also fail the job.
This follows the products service's scanning policy.

Actions are pinned to full commit SHAs, repository permissions are read-only,
and checkout does not persist credentials. The workflow does not load `.env`,
access production databases, publish images, or deploy. Required checks and
branch protection must be configured separately after an authorized GitHub run.