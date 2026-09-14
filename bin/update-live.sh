#!/usr/bin/env bash
# plane-cli background updater — TAG-BASED, never on the CLI hot path.
#
# Model (operator directive):
#   - Releases are GIT TAGS (plane-vX.Y.Z) pushed to origin. main is dev flow,
#     NOT a release channel.
#   - This script runs from a systemd user TIMER (background). The CLI shim
#     NEVER fetches/pulls — it only resolves a symlink.
#   - Update flow: fetch tags → newest tag vs current pin → deploy into a
#     STAGING dir → bun install + tests there → ATOMIC symlink flip.
#   - A run already in flight keeps executing the previous version (its bun
#     process loaded the old files); the NEXT invocation resolves the new one.
#
# Layout:
#   PLANE_CLI_LIVE_REPO  bare-ish checkout that only fetches (default
#                        /home/rafael/Development/plane-cli-live)
#   PLANE_CLI_RELEASES   one dir per released tag (default .../releases)
#   PLANE_CLI_CURRENT    symlink → releases/<tag>  (the ONLY thing the shim reads)
#
# Manual release (no waiting for the timer): bin/deploy.sh <src> <tag>
set -euo pipefail

REPO="${PLANE_CLI_LIVE_REPO:-/home/rafael/Development/plane-cli-live}"
RELEASES="${PLANE_CLI_RELEASES:-/home/rafael/Development/plane-cli-releases}"
CURRENT="${PLANE_CLI_CURRENT:-/home/rafael/Development/plane-cli-current}"
TAG_PREFIX="${PLANE_CLI_TAG_PREFIX:-plane-v}"
LOCK="$RELEASES/.update.lock"

mkdir -p "$RELEASES"

# Single updater instance (O_EXCL claim via open -x; stale handled by age).
if ! ( set -o noclobber; : > "$LOCK" ) 2>/dev/null; then
  at=$(stat -c %Y "$LOCK" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $((now - at)) -gt 600 ]; then rm -f "$LOCK"; ( set -o noclobber; : > "$LOCK" ) 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rm -f "$LOCK"' EXIT

# 1. What is the newest release tag?
# Host ssh_config may be broken (no sudo to fix) — pin a clean ssh command.
export GIT_SSH_COMMAND="${PLANE_CLI_GIT_SSH:-ssh -F /dev/null}"
git -C "$REPO" fetch --quiet origin '+refs/tags/plane-v*:refs/tags/plane-v*' 2>/dev/null || true
LATEST=$(git -C "$REPO" tag -l "${TAG_PREFIX}*" --sort=-v:refname | head -n 1)
[ -n "$LATEST" ] || { echo "update: no ${TAG_PREFIX}* tags on origin — nothing to do"; exit 0; }

# 2. What is pinned now?
if [ -L "$CURRENT" ]; then
  PINNED=$(basename "$(readlink "$CURRENT")")
else
  PINNED="none"
fi
[ "$LATEST" = "$PINNED" ] && exit 0

# 3. Already staged? Else stage: worktree at the tag, install, test.
TARGET="$RELEASES/$LATEST"
if [ ! -d "$TARGET" ]; then
  STAGE="$TARGET.staging.$$"
  git -C "$REPO" worktree add --quiet --detach "$STAGE" "refs/tags/$LATEST"
  if ! ( cd "$STAGE" && bun install --frozen-lockfile >/dev/null 2>&1 && bun test >/tmp/plane-release-test.log 2>&1 ); then
    echo "update: $LATEST FAILED staging tests — keeping $PINNED (log: /tmp/plane-release-test.log)" >&2
    git -C "$REPO" worktree remove --force "$STAGE"
    exit 1
  fi
  mv "$STAGE" "$TARGET"
  git -C "$REPO" worktree prune
fi

# 4. Atomic flip: symlink swap (mv -T on a tmp link).
TMP="$RELEASES/.current.tmp.$$"
ln -sfn "$TARGET" "$TMP"
mv -T "$TMP" "$CURRENT"
echo "update: $PINNED -> $LATEST"
