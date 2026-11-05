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
stub gh 'echo green'
stub sudo '[ "$1 $2" = "systemctl restart" ] && echo restart >> "$STUB_DIR/restarts"; exit 0'
stub curl '[ "$(git rev-parse HEAD)" != "$(cat "$STUB_DIR/bad")" ]'   # healthy unless on the bad commit
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

[ "$fails" = 0 ] || exit 1
echo "auto-update.test: OK"
