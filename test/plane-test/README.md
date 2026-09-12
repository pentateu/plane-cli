# plane-test: supporting test services for the plane CLI

Ephemeral, per-run infrastructure for plane CLI integration tests. Nothing
here is long-lived: bring it up, run the suite, tear it down.

## NATS

`compose.yaml` starts a single `nats:2.10-alpine` node (JetStream on),
following the TC-38 review/e2e pattern:

- client port bound **127.0.0.1 only**, high-ephemeral default `24322`
  (chosen free at authoring time; override with `PLANE_TEST_NATS_PORT`)
- host connection string: `nats://127.0.0.1:${PLANE_TEST_NATS_PORT:-24322}`
- no port leaks: teardown removes the container and its data

```sh
docker compose -p plane-test up -d          # start
docker compose -p plane-test down -v        # teardown (removes container + volume)
```

## Plane TEST project (live instance)

The live Plane instance (URL the CLI already resolves) hosts a dedicated
smoke-test project so CLI round-trips never touch production tickets:

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
`test/probe-project-create.ts` (reads the seat token via the same env
resolution as the CLI; never prints it).
