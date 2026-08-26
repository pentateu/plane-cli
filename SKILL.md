---
name: plane-cli
description: Use when reading or writing Ai Tutor tickets on Plane (https://rafael-linux.tail8a19c.ts.net) — claiming work, filing bugs/features/ops tasks, moving states, commenting, or replying to review comments. Replaces raw curl against the Plane API.
---

# plane-cli

`plane` is the agent-only ticket CLI for the Ai Tutor tracker — standalone repo
[pentateu/plane-cli](https://github.com/pentateu/plane-cli), installed on PATH
via shim (self-pulls latest main). If `plane` is not on PATH:

```sh
bun ~/Development/plane-cli/src/cli.ts <verb> …
```

## Contract

`plane help` is the canonical contract text (I/O streams, exit taxonomy,
handles, flag rules). Do not restate it here — trust `help`, and if this file
ever disagrees with `help`, `help` wins.

## Auth

Seats are PER-PROJECT identities — `dev1` here and `dev1` in another project
are different accounts; this repo's `.plane-seats` holds THIS project's fleet
tokens only. Seat resolution: `--seat <name>` > `$PLANE_SEAT`. Token
resolution, in order:

1. **Project-scoped `.plane-seats`** — walks up from your current directory
   (gitignored, chmod 600, at the repo root). Keys:
   `HOMETUTOR_TICKETS_TOKEN_<SEAT>`.
2. Legacy `~/.config/plane/seats.env` (same keys).
3. `$PLANE_TOKEN` or an exported `$HOMETUTOR_TICKETS_TOKEN_<SEAT>`.

Always use YOUR OWN seat — attribution lands on the board. If the token is
missing, `plane` exits 2 telling you exactly which key to add to `.plane-seats`.
The admin bootstrap token is never used implicitly.

## Decision trees

**Claim a ticket**
0. Before claiming, check `plane list --blocked-by` — never claim a ticket
   blocked by an open ticket. `plane get HT-N --fields blockedBy,state` shows
   who holds HT-N up.
1. `plane claim HT-N --comment "starting"` — assigns you + moves to progress.
   The comment posts only when something actually changed, so retrying a timed-
   out claim never duplicates it (`commentPosted:false` tells you).

**Wire dependencies between tickets (blocking edges)**
1. `plane blocks HT-A HT-B` — edge: A blocks B. `plane depends HT-B HT-A`
   spells the identical edge from the dependent side; both are idempotent
   (re-applying => `changed:false`, exit 0). Set edges at creation time when
   filing work with known ordering.
2. `plane unblocks HT-A HT-B` removes the edge.
3. Read side: `get` renders `blockedBy[]`/`blocks[]`; `list --blocked-by HT-N`
   answers "what can start now".

**Close out your fix**
1. `plane state HT-N verify --comment "branch feature/x @ <sha>"` after merge-
   readiness. Here `--comment` IS the payload: it posts even when the state is
   already correct, and reports `commentPosted:true`.

**File a bug/feature/ops task**
1. `plane create --title "[bug] short title" --type bug --priority high --body-md notes.md`
2. Priority maps P0→urgent, P1→high, P2→medium.
3. Labels resolve against the LIVE board — an unknown type fails loudly listing
   what exists instead of creating unlabeled tickets.

**Break a plan into sub-tickets (§11 checklist)**
1. `plane sub HT-N --title "[impl] phase name" --type plan --body "…scope…"` per child.

**Review-feedback loop (comment → fix → reply)**
1. `plane get HT-N --comments` — read the numbered thread (`c1`, `c2`, … oldest first).
2. Implement each requested change.
3. `plane reply HT-N c3 "fixed in <sha> — what changed"` per comment. The thread
   then tracks exactly which feedback was addressed.

**Triage / find work**
1. `plane list --state todo` · `plane list --assignee me --state progress` · `plane list --parent HT-N`.

## Gotchas

- `create`/`sub` are NOT idempotent — a timeout is not a failure signal; check
  `plane list --search <title>` before re-filing.
- Comment handles (`cN`) are positional by age: re-run `comments HT-N` if new
  comments may have landed since you read the thread. Under concurrency your
  reply may land later than its handle suggests — the thread content, not the
  number, is authoritative.
- Concurrent claims on one ticket are last-writer-wins on Plane's side; after
  claiming, `assignees` in the response shows server truth — if you are missing,
  re-run `claim`.
- Descriptions come HTML-stripped and capped (~500 chars); use `--full` before
  quoting long specs. Comments stay capped at their upstream limits even with
  `--full`.
- First call per hour warms the disk cache; `plane sync` force-refreshes after
  someone else renames states/labels on the board. Board drift otherwise fails
  LOUD (missing state/label → exit 3 + `plane sync then retry`), never silently.
  `sync` also refreshes blocking edges into the cache so short-handle rendering
  works offline.
- `unblocks` requires the plane-fork relation-DELETE patch: stock Plane's
  public API exposes relations as GET+POST only, so removal fails loud (exit 1)
  with guidance until the instance is patched. Creating/reading edges works on
  stock instances.
