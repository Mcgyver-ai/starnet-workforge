#!/usr/bin/env bash
# shellcheck disable=SC2016  # the stubs' $ expand when the stubs run, not here
# Runs the real auto-update.sh in a throwaway clone, with sudo, gh, curl, flock and sleep stubbed: a commit that fails
# its health check is rolled back and not retried, and a newer good commit still lands. No root, network or service.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/auto-update.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export STUB_DIR="$TMP" XDG_RUNTIME_DIR="$TMP"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

mkdir "$TMP/bin"
stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$TMP/bin/$1"; chmod +x "$TMP/bin/$1"; }
stub flock 'exit 0'
stub sleep 'exit 0'
stub sudo '[ "$1 $2" = "systemctl restart" ] && echo restart >> "$STUB_DIR/restarts"; exit 0'
stub npm '[ -f "$STUB_DIR/npm-works" ]'
# GitHub's check results come from $STUB_DIR/checks; the station is healthy unless on the bad commit
stub curl 'case "$*" in *check-runs*) cat "$STUB_DIR/checks" ;; *) [ "$(git rev-parse HEAD)" != "$(cat "$STUB_DIR/bad")" ] ;; esac'
checks() { echo "{\"check_runs\":[{\"status\":\"$1\",\"conclusion\":\"$2\"}]}" > "$TMP/checks"; }
checks completed success
export PATH="$TMP/bin:$PATH"

git init --quiet --bare -b main "$TMP/origin.git"
git clone --quiet "$TMP/origin.git" "$TMP/pusher" 2>/dev/null
commit() { git -C "$TMP/pusher" commit --quiet --allow-empty -m "$1"; git -C "$TMP/pusher" push --quiet origin HEAD:main; git -C "$TMP/pusher" rev-parse HEAD; }

A="$(commit first)"
git clone --quiet "$TMP/origin.git" "$TMP/vm"
mkdir -p "$TMP/vm/deploy/oracle-vm"
cp "$SCRIPT" "$TMP/vm/deploy/oracle-vm/auto-update.sh"
update() { bash "$TMP/vm/deploy/oracle-vm/auto-update.sh" >/dev/null 2>&1; }

fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok: $1"; else echo "FAIL: $1 (expected $3, got $2)"; fails=$((fails + 1)); fi; }
head_now() { git -C "$TMP/vm" rev-parse HEAD; }
restarts() { if [ -f "$TMP/restarts" ]; then wc -l < "$TMP/restarts" | tr -d ' '; else echo 0; fi; }

BAD="$(commit bad)"
echo "$BAD" > "$TMP/bad"
rc=0; update || rc=$?
expect "a failed update reports failure" "$rc" 1
expect "it rolls back to the old commit" "$(head_now)" "$A"
expect "it restarts onto the bad commit and back" "$(restarts)" 2

rc=0; update || rc=$?
expect "the next run is not an error" "$rc" 0
expect "the next run stays on the old commit" "$(head_now)" "$A"
expect "the next run does not restart the station" "$(restarts)" 2

GOOD="$(commit good)"
rc=0; update || rc=$?
expect "a newer good commit still lands" "$(head_now)" "$GOOD"
expect "with one restart and no error" "$rc:$(restarts)" 0:3

UNCHECKED="$(commit unchecked)"
checks completed failure
rc=0; update || rc=$?
expect "a failed check holds the update" "$rc:$(head_now)" "0:$GOOD"
checks in_progress null
rc=0; update || rc=$?
expect "so does a check still running" "$rc:$(head_now)" "0:$GOOD"
checks completed success
update
expect "a green commit lands" "$(head_now)" "$UNCHECKED"

# npm's network is down: the update and its rollback both fail, and only a later retry can repair node_modules
echo changed > "$TMP/pusher/package-lock.json"
git -C "$TMP/pusher" add package-lock.json
LOCK="$(commit lockfile)"
rc=0; update || rc=$?
expect "an update and rollback that both fail report failure" "$rc" 1
touch "$TMP/npm-works"
update
expect "the next run tries that commit again" "$(head_now)" "$LOCK"

[ "$fails" = 0 ] || exit 1
echo "auto-update.test: OK"
