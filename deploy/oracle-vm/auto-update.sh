#!/usr/bin/env bash
# Pull-based station updates: the starnet-update timer runs this every 15 minutes (setup.sh installs it).
# It fast-forwards the checkout to its upstream branch ONLY when every GitHub check on the new commit passed,
# reinstalls dependencies when the lockfile changed, restarts the station, and rolls back if /api/health fails.
# Nothing reaches into the VM: no inbound port, no deploy key in GitHub. Needs `gh auth login` for the CI check.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE=/etc/starnet/starnet.env
cd "$REPO_DIR"

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/starnet-update.lock"
flock -n 9 || { echo "another update is running"; exit 0; }

BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || { echo "detached HEAD: check out the branch to follow first" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "local edits in $REPO_DIR — not updating over them:" >&2; git status --short --untracked-files=no >&2; exit 1
fi

git fetch --quiet origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse FETCH_HEAD)"
[ "$OLD" = "$NEW" ] && { echo "up to date at ${OLD:0:9}"; exit 0; }
git merge-base --is-ancestor "$OLD" "$NEW" || { echo "origin/$BRANCH is not a fast-forward of ${OLD:0:9}: fix by hand" >&2; exit 1; }

# owner/repo from the origin URL (https or ssh form)
SLUG="$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
# every check run finished, none failed, and at least one exists (a commit CI has not picked up yet waits)
# shellcheck disable=SC2016  # $bad is a jq variable, not a shell one
VERDICT="$(gh api "repos/$SLUG/commits/$NEW/check-runs?per_page=100" --jq '
  [.check_runs[] | select(.status != "completed" or (.conclusion | IN("success","skipped","neutral") | not))] as $bad
  | if (.check_runs | length) == 0 then "none" elif ($bad | length) > 0 then "wait" else "green" end')"
[ "$VERDICT" = green ] || { echo "${NEW:0:9}: CI is '$VERDICT' — staying on ${OLD:0:9}"; exit 0; }

PORT="$(sudo sed -n 's/^STARNET_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1 || true)"
PORT="$(printf '%s' "$PORT" | sed -E "s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/")"
PORT="${PORT:-8787}"

deploy() {   # $1 = commit to run; reinstalls deps only when the lockfile differs from what is installed
  # (set -e is off inside a function called from `if`, so every step returns on failure explicitly)
  local from; from="$(git rev-parse HEAD)"
  git merge --quiet --ff-only "$1" 2>/dev/null || git reset --quiet --hard "$1" || return 1
  if ! git diff --quiet "$from" "$1" -- package-lock.json; then
    ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund || return 1
  fi
  # shortcut: restarts even mid-run (the station journals interrupted runs for the next boot); add a busy check if that bites
  sudo systemctl restart starnet || return 1
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null "http://127.0.0.1:${PORT}/api/health" && return 0
    sleep 1
  done
  return 1
}

echo "updating ${OLD:0:9} -> ${NEW:0:9} ($(git log -1 --format=%s "$NEW"))"
if deploy "$NEW"; then
  echo "station healthy on ${NEW:0:9}"
  exit 0
fi
echo "station unhealthy on ${NEW:0:9} — rolling back to ${OLD:0:9}" >&2
deploy "$OLD" || echo "rollback did not come up healthy either: journalctl -u starnet -n 100" >&2
exit 1
