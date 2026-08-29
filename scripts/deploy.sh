#!/usr/bin/env bash
# deploy.sh — push-based rollout for plane (plane-cli) to fleet.
# Replaces per-invocation auto-pull (every `plane` run did `git pull`).
# Now `plane` never pulls on its own; run this after pushing to origin/development.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
echo "==> local: git pull --ff-only origin/development"
git fetch origin development --prune 2>&1 | sed 's/^/  /'
BEFORE="$(git rev-parse HEAD)"
if ! git pull --ff-only origin development 2>&1 | sed 's/^/  /'; then echo "local pull failed" >&2; exit 1; fi
AFTER="$(git rev-parse HEAD)"
if [[ "$BEFORE" == "$AFTER" ]]; then echo "local already up-to-date ($AFTER)"; else echo "local updated $BEFORE -> $AFTER"; fi
if [[ "${1:-}" == "--local-only" ]]; then echo "local-only, skip fleet"; exit 0; fi
declare -A HOSTS=(
  [alpha]="rafael@rafael-linux.tail8a19c.ts.net rafael@rafael-linux.local"
  [vps-test]="root@vps-test.tail8a19c.ts.net root@192.168.0.10"
  [jon-vps]="root@jon-vps.tail8a19c.ts.net root@167.86.84.230"
  [plexypi]="rafael@plexypi.tail8a19c.ts.net"
)
if [[ -n "${FLEET:-}" ]]; then
  FILTERED=()
  for k in $FLEET; do
    if [[ -n "${HOSTS[$k]+x}" ]]; then FILTERED+=("$k"); else echo "unknown host '$k'" >&2; exit 2; fi
  done
  KEYS=("${FILTERED[@]}")
else
  KEYS=("${!HOSTS[@]}")
fi
IFS=$'\n' KEYS=($(sort <<<"${KEYS[*]}")); unset IFS
FAIL=0
for host in "${KEYS[@]}"; do
  candidates="${HOSTS[$host]}"
  ok=0
  for ssh_target in $candidates; do
    echo ""
    echo "==> $host via $ssh_target"
    if ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new "$ssh_target" "
      set -e
      for d in \"\$HOME/Development/plane-cli\" \"\$HOME/plane-cli\" \"/opt/plane-cli\"; do
        if [ -d \"\$d/.git\" ]; then
          echo \"  repo at \$d\"
          cd \"\$d\"
          echo \"  before \$(git rev-parse --short HEAD 2>/dev/null || echo ?)\"
          if [ -n \"\$(git status --porcelain --untracked-files=no 2>/dev/null)\" ]; then echo \"  skip: dirty\" >&2; exit 0; fi
          if git pull --ff-only origin development 2>&1 | sed 's/^/  /'; then
            echo \"  after \$(git rev-parse --short HEAD)\"
            command -v bun >/dev/null 2>&1 && bun x tsc --noEmit 2>&1 | sed 's/^/  /' || true
          else echo \"  pull failed\" >&2; exit 1; fi
          exit 0
        fi
      done
      echo \"  no repo found — skip\" >&2; exit 0
    " 2>&1; then
      echo "  $host: ok via $ssh_target"
      ok=1
      break
    else
      echo "  $host: failed via $ssh_target — try next" >&2
    fi
  done
  if [[ $ok -eq 0 ]]; then echo "  $host: FAILED" >&2; FAIL=$((FAIL+1)); fi
done
echo ""
if [[ $FAIL -eq 0 ]]; then echo "deploy: all ${#KEYS[@]} hosts ok"; exit 0; else echo "deploy: $FAIL/${#KEYS[@]} failed" >&2; exit 1; fi
