# plane-cli

Agent-only CLI for the Ai Tutor workspace's Plane tracker (https://tools-small.tail8a19c.ts.net) — tickets across all workspace projects, addressed by `<IDENT>-<seq>` handles (`HT-17`, `TC-17`, `XT-2`, …; `plane projects` lists live identifiers).
Companion to `outline-cli` (`ot`). Process owner: `docs/REQUESTS.md` in
pentateu/AI_Tutor; full usage doc: `docs/ops/PLANE_CLI.md` there.

## Run

```sh
bun src/cli.ts <verb> …        # from a clone of this repo
plane <verb> …                 # via PATH shim (below)
```

## Install (fleet)

```sh
git clone git@github.com:pentateu/plane-cli.git ~/Development/plane-cli
ln -s ~/Development/plane-cli/bin/plane ~/.local/bin/plane
```

The shim **never auto-pulls** (push-based, 2026-08-29). After you push
`origin/main`, roll out with `scripts/deploy.sh` (see `outline-cli` for fleet
pattern). Opt-in: `PLANE_AUTO_PULL=1 plane ...`. No network on normal runs.

## Auth — seats are PER-PROJECT identities

Seat names are unique per project: `dev1` in project A and `dev1` in project B
are different Plane accounts with different tokens. Every project runs its own
fleet (dev1…, tester1…, review1…, design, docs), provisions its own users in
its Plane workspace (`<seat>-<project>@…` naming), and keeps its own
credentials:

- **`.plane-seats`** (project root, gitignored, provision as chmod 600) — keys
  `HOMETUTOR_TICKETS_TOKEN_<SEAT>`, one per line.
- **`.plane-env`** (same rules) — `PLANE_URL`, `PLANE_API_BASE`,
  workspace, project id.

The CLI walks up from your current directory to find these files, so tokens
never leave the project they belong to — cross-project bleed is impossible by
construction. Precedence: project `.plane-seats` > legacy
`~/.config/plane/seats.env` > exported `$HOMETUTOR_TICKETS_TOKEN_<SEAT>` >
`$PLANE_TOKEN`. The admin bootstrap token is never used implicitly.

### Onboard a new project (one-time)

1. Create one Plane user per seat in that workspace; add each to the project.
2. As each seat user: Settings → API keys → mint one token.
3. Write `HOMETUTOR_TICKETS_TOKEN_<SEAT>=…` lines into the project root's
   `.plane-seats`; fill `.plane-env`.
4. Verify per seat: `plane --seat <name> whoami`.

Reference deployment: **pentateu/AI_Tutor** (Ai Tutor project).

`plane help` is the canonical contract text.
