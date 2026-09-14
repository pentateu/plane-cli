#!/usr/bin/env bash
# plane deploy — explicit release into the PINNED live checkout.
#
# Model (operator directive, TC-95 release — mirrors teamctl bin/deploy.sh):
#   - Dev happens in /home/rafael/Development/plane-cli (or any worktree).
#   - Agents execute the LIVE checkout (PLANE_CLI_LIVE, default
#     /home/rafael/Development/plane-cli-live) via the ~/.local/bin/plane shim.
#   - Merging to main deploys NOTHING by itself. This script is the deploy:
#     run it after a release is fully tested.
#   - The shim must NEVER git-pull/fetch (hot path). This script is the
#     only writer of the live checkout.
#
# Usage: bin/deploy.sh [src] [branch|commit]   (defaults: origin main)
#   This host until the ssh_config perms are fixed (fetch origin fails):
#     bin/deploy.sh /home/rafael/Development/plane-cli main
set -euo pipefail

LIVE="${PLANE_CLI_LIVE:-/home/rafael/Development/plane-cli-live}"
SRC="${1:-origin}"
REF="${2:-main}"

if [ ! -d "$LIVE/.git" ]; then
  echo "deploy: no live checkout at $LIVE" >&2
  exit 1
fi
if [ -n "$(git -C "$LIVE" status --porcelain)" ]; then
  echo "deploy: live checkout is dirty — refusing to touch it:" >&2
  git -C "$LIVE" status --short >&2
  exit 1
fi

before_lock="$(sha1sum "$LIVE/bun.lock" | cut -d' ' -f1)"
before_head="$(git -C "$LIVE" rev-parse --short HEAD)"
git -C "$LIVE" fetch "$SRC" "$REF"
git -C "$LIVE" checkout --quiet FETCH_HEAD -- 2>/dev/null || true
# Detach at the exact released commit (branch/commit-hash target support):
git -C "$LIVE" checkout --quiet --detach FETCH_HEAD
after_head="$(git -C "$LIVE" rev-parse --short HEAD)"
after_lock="$(sha1sum "$LIVE/bun.lock" | cut -d' ' -f1)"

echo "deploy: $before_head -> $after_head ($SRC/$REF)"
if [ "$before_head" = "$after_head" ]; then
  echo "deploy: already at $after_head — nothing to do"
  exit 0
fi

if [ "$before_lock" != "$after_lock" ]; then
  echo "deploy: bun.lock changed — reinstalling dependencies"
  bun install --frozen-lockfile
fi

bun test 2>&1 | tail -n 3
echo "deploy: live checkout now at $(git -C "$LIVE" rev-parse --short HEAD) — shims pick it up on next run"
