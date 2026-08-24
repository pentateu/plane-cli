# plane-cli

Agent-only CLI for the Ai Tutor tracker on Plane (https://plane.iswe.co.nz).
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

The shim resolves symlinks and fast-forward-pulls this repo before every run
when the checkout is clean (skip with `PLANE_NO_PULL=1`) — PATH installs always
execute latest main.

## Auth — project-scoped by design

Credentials live in **`.plane-seats`** (gitignored, chmod 600), found by walking
up from your current directory. Keys: `HOMETUTOR_TICKETS_TOKEN_<SEAT>`.
Precedence: project `.plane-seats` > legacy `~/.config/plane/seats.env` >
exported `$HOMETUTOR_TICKETS_TOKEN_<SEAT>` > `$PLANE_TOKEN`. Provision per-seat
tokens as chmod 600 files; the admin bootstrap token is never used implicitly.

`plane help` is the canonical contract text.
