# plane-test: supporting test services for the plane CLI

Ephemeral, per-run infrastructure for plane CLI integration tests. Nothing
here is long-lived: bring it up, run the suite, tear it down.

## Local Plane TEST instance (primary — zero production contact)

The local stack below is the primary test target: nothing in this section
touches any shared instance. (The live `TESTCLI` opt-in smoke is documented
separately at the bottom.)

`docker-compose.yml` (`-p plane-test`) mirrors the prod plane-selfhost
compose (`~/plane-selfhost/plane-app`): same images — backend fork
`pentateu/plane-backend:v1.4.1-iswe` included — same service topology
(`plane-db`, `plane-redis`, `plane-mq`, `plane-minio`, `migrator`, `api`,
`worker`). Two filename conventions are intentional: `docker-compose.yml`
for the Plane stack (prod file is named the same), `compose.yaml` for the
NATS sidecar (upstream Plane/Compose convention) — every NATS call site
passes `-f` explicitly. Frontend services (`web`, `space`, `admin`, `live`,
`proxy`) are absent on purpose: the CLI only talks to `/api/v1`, and the
proxy's `8097`/`8443` binds stay with prod. `beat-worker` (periodic tasks)
is likewise absent: no CLI CRUD path needs it.

- API: `http://127.0.0.1:3211` (host) → `8000` (container), bind
  **127.0.0.1 only**; postgres `127.0.0.1:5455` → `5432`. No other service
  publishes a host port. Defaults were free at authoring time (prod
  `8097`/`8443`, ot-test `3111`/`5454` avoid them); override without editing:
  `PLANE_TEST_API_PORT=3221 PLANE_TEST_PG_PORT=5456` (seed.sh reads the same
  variables, so URL + env file follow automatically).
- secrets are dummies inline; service names match prod defaults so no extra
  env mapping was needed (`plane-db`, `plane-redis`, `plane-mq:5672/plane`,
  minio `uploads` bucket).

```sh
docker compose -p plane-test up -d   # start all (migrator runs, then exits 0)
./seed.sh                            # user + token + workspace + TEST project + type labels
set -a; . ./.plane-test-env; set +a  # PLANE_API_BASE + seat + token + project + test-local cache
plane whoami                         # {"seat":"test",...} — proves the stack answers
docker compose -p plane-test down -v && rm -f .plane-test-env .plane-cache
# teardown (removes containers + volumes; no port leaks — verify with ss -tln)
```

`seed.sh` is idempotent (re-runnable: existing user/workspace/project/
labels are reused, and a stale cached token is detected and replaced) and
NEVER prints the token — it writes the gitignored `.plane-test-env`
(`umask 077` + `chmod 600`). Seed details:

- user `test@iswe.co.nz`: the seat name MUST equal the member's email
  local-part — that is how the CLI maps `--seat`/`PLANE_SEAT` to a roster
  member. Any other seat name 403s/404s against this stack.
- workspace `plane-cli-test` (shell-created; the v1 API the CLI speaks has
  no workspace create — workspace list/create lives on the session-authed
  `/api/` app router).
- project `TEST` (v1 REST-created, so default states come from real code
  paths) + the four CLI labels (`type:bug`, `type:feature`, `type:ops`,
  `type:plan`; v1 project create does not provision labels).
- verified 2026-09-12: full `create → comment → state → get → delete`
  round-trip green (`TEST-1`, then deleted; final `list` empty).

Cache warning (proven here): the CLI caches `labels:<projectId>` in
`PLANE_CACHE` — seed (or create) labels AFTER a run cached the empty map and
`create --type` fails until the cache is dropped. Always use the test-local
`PLANE_CACHE` from `.plane-test-env` (never your dev cache), and `rm -f`
it whenever the seed changes labels/states.

## NATS

`nats/compose.yaml` starts a single `nats:2.10-alpine` node (JetStream on),
following the TC-38 review/e2e pattern:

- client port bound **127.0.0.1 only**, high-ephemeral default `24322`
  (chosen free at authoring time; override with `PLANE_TEST_NATS_PORT`)
- host connection string: `nats://127.0.0.1:${PLANE_TEST_NATS_PORT:-24322}`
- no port leaks: teardown removes the container and its data

```sh
docker compose -f nats/compose.yaml -p plane-test-nats up -d       # start
docker compose -f nats/compose.yaml -p plane-test-nats down -v     # teardown (removes the container; storage is tmpfs)
```

NOTE: run NATS under a DIFFERENT project name (`-p plane-test-nats`) — the
bare `-p plane-test` name belongs to the Plane stack above.

## Plane TEST project (live instance — opt-in smoke only)

Prefer the local stack above for every CLI change. The live Plane instance
(URL the CLI already resolves) additionally hosts a dedicated smoke-test
project, for the integration points the local stack cannot prove:

- identifier: `TESTCLI`
- project id: `80827c11-829a-4e1a-add8-7eda7c58a3de`
- workspace: `ai-tutor`
- provisioned: the four standard CLI labels (`type:bug`, `type:feature`,
  `type:ops`, `type:plan`); the default state set (Backlog/Todo/In
  Progress/Done/Cancelled) matches the CLI's state tokens as-is.

Usage with the CLI (from a checkout whose `.plane-seats` holds your seat,
e.g. teamctl with `PLANE_SEAT=dev2`):

```sh
PLANE_CACHE=$(mktemp -u) \
PLANE_SEAT=dev2 \
PLANE_PROJECT_ID=80827c11-829a-4e1a-add8-7eda7c58a3de \
PLANE_IDENT=TESTCLI \
plane create --title "smoke" --type ops --body "<p>x</p>"
```

`PLANE_CACHE` should be fresh (or omitted) per run — the project registry
cache is 24h-TTL and will otherwise hide newly created projects.

## Known CLI gap (recorded, not hacked around)

`plane create` / `plane sub` can only file into the DEFAULT project
(`src/cli.ts` `create` case: `projectId ?? p.projectId()`); `--project` /
identifier targeting for `create` does not exist yet. Handle-addressed
verbs (`get`, `comment`, `state`, `delete`, …) DO resolve `TESTCLI-N`
handles against any project via the registry. Until a `--project` flag
exists, integration tests should scope the whole invocation with
`PLANE_PROJECT_ID` + `PLANE_IDENT` as shown above — that is the CLI's own
documented config surface, not a workaround.

## Project creation was NOT admin-gated

`POST /api/v1/workspaces/{workspace}/projects/` with a regular seat API
token (dev2) returned `201` directly — no admin step needed. Probe:
`test/manual/probe-project-create.ts` — manual only, requires
`PLANE_API_BASE` explicitly (no live default), seat/seats-file from
argv/env; reads the seat token via CLI-equivalent resolution, never
prints it.

## Automated coverage (explicit gap)

`bun test` covers the CLI unit surface only (143 pass pre-existing) — it
does NOT drive this stack: a broken `seed.sh`, a typo'd image tag, or a
deleted label loop stays green. Gate any future suite on a smoke test that
brings the stack up, runs seed, and asserts the project + labels exist.
Until such a suite exists, the verified-by-hand record is: 2026-09-12 full
`create → comment → state → get → delete` round-trip green twice from
scratch (most recent `TEST-1`, then deleted; final `list` empty).
