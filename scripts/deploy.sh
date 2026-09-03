#!/usr/bin/env bash
# deploy.sh — push-based rollout for plane (plane-cli) to all fleet hosts.
#
# Replaces the old per-invocation auto-pull (every `plane` run did `git pull`).
# Now `plane` never pulls on its own; you run this script after pushing to
# `origin/main` to update every host that runs `plane`.
#
# Usage:
#   ./scripts/deploy.sh              # pull locally, then push to fleet
#   ./scripts/deploy.sh --local-only # only pull locally, don't ssh
#   FLEET="alpha tools-small" ./scripts/deploy.sh  # subset
#
# Fleet is defined in Infra/README.md; tailscale names are primary, LAN IPs fallback.
# The repo is expected at ~/Development/plane-cli on each host on that host).
# No secrets are printed; the script is read-only except for `git pull`.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ---- local pull ----
echo "==> local: git pull --ff-only origin/main"
git fetch origin main --prune 2>&1 | sed 's/^/  /'
BEFORE="$(git rev-parse HEAD)"
if ! git pull --ff-only origin main 2>&1 | sed 's/^/  /'; then
  echo "local pull failed (maybe not on main or dirty) — abort" >&2
  exit 1
fi
AFTER="$(git rev-parse HEAD)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "local already up-to-date ($AFTER)"
else
  echo "local updated $BEFORE -> $AFTER"
fi

if [[ "${1:-}" == "--local-only" ]]; then
  echo "local-only, skip fleet"
  exit 0
fi

# ---- fleet ----
# Primary via tailscale, fallback via LAN IP. Add/remove hosts here when fleet changes.
# Keep in sync with Infra/README.md and Infra/linux-note/INVENTORY.md
# Uses plain function for bash 3.2 (macOS) compat — no associative arrays.
ALL_HOSTS="alpha tools-small jon-vps plexypi"
get_candidates() {
  case "$1" in
    alpha) echo "rafael@aorus-server.tail8a19c.ts.net rafael@aorus-server.local rafael@192.168.0.162" ;;
    tools-small) echo "root@tools-small.tail8a19c.ts.net root@192.168.0.10" ;;
    vps-test) echo "root@tools-small.tail8a19c.ts.net root@192.168.0.10" ;;
    jon-vps) echo "root@jon-vps.tail8a19c.ts.net root@167.86.84.230" ;;
    plexypi) echo "rafael@plexypi.tail8a19c.ts.net rafael@plexypi.local" ;;
    macos-vm) echo "rafael@macos-vm.tail8a19c.ts.net rafael@100.67.238.71" ;;
    *) echo "" ;;
  esac
}
is_known_host() {
  case "$1" in alpha|tools-small|vps-test|jon-vps|plexypi|macos-vm) return 0;; *) return 1;; esac
}

# Allow FLEET env to filter: "alpha vps-test" etc.
if [[ -n "${FLEET:-}" ]]; then
  FILTERED=()
  for k in $FLEET; do
    if is_known_host "$k"; then
      FILTERED+=("$k")
    else
      echo "unknown fleet host '$k' (known: $ALL_HOSTS)" >&2
      exit 2
    fi
  done
  KEYS=("${FILTERED[@]}")
else
  # shellcheck disable=SC2207
  KEYS=($ALL_HOSTS)
fi

# Sort for stable output
IFS=$'\n' KEYS=($(sort <<<"${KEYS[*]}")); unset IFS

FAIL=0
for host in "${KEYS[@]}"; do
  candidates="$(get_candidates "$host")"
  ok=0
  for ssh_target in $candidates; do
    echo ""
    echo "==> $host via $ssh_target"
    # Try to locate repo on remote; try common paths
    if ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new "$ssh_target" "
      set -e
      for d in \"\$HOME/Development/plane-cli\" \"\$HOME/plane-cli\" \"/opt/plane-cli\"; do
        if [ -d \"\$d/.git\" ]; then
          echo \"  repo at \$d\"
          cd \"\$d\"
          echo \"  before \$(git rev-parse --short HEAD 2>/dev/null || echo ?)\"
          if [ -n \"\$(git status --porcelain --untracked-files=no 2>/dev/null)\" ]; then
            echo \"  skip: dirty tracked tree\" >&2
            exit 0
          fi
          if git pull --ff-only origin main 2>&1 | sed 's/^/  /'; then
            echo \"  after \$(git rev-parse --short HEAD)\"
            # verify bun still runs
            if command -v bun >/dev/null 2>&1; then
              bun x tsc --noEmit 2>&1 | sed 's/^/  /' || true
            fi
          else
            echo \"  pull failed\" >&2
            exit 1
          fi
          exit 0
        fi
      done
      echo \"  no repo found at ~/Development/plane-cli, ~/plane-cli, /opt/plane-cli — skip\" >&2
      exit 0
    " 2>&1; then
      echo "  $host: ok via $ssh_target"
      ok=1
      break
    else
      echo "  $host: failed via $ssh_target — try next candidate" >&2
    fi
  done
  if [[ $ok -eq 0 ]]; then
    echo "  $host: FAILED (all candidates)" >&2
    FAIL=$((FAIL+1))
  fi
done

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "deploy: all ${#KEYS[@]} hosts ok"
  exit 0
else
  echo "deploy: $FAIL/${#KEYS[@]} hosts failed" >&2
  exit 1
fi
