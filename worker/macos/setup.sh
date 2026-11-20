#!/bin/bash
# Install/refresh the Darkroom worker as a LaunchAgent in the current user's login session.
# Run from the repo checkout on the Mac:  worker/macos/setup.sh
set -euo pipefail
WORKER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$WORKER_DIR/.." && pwd)"
LABEL=com.darkroom.worker
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/darkroom-worker"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
if [ -z "$NODE" ]; then echo "Node.js not found. Install it: brew install node" >&2; exit 1; fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then echo "Node >= 22 required (found $("$NODE" -v))" >&2; exit 1; fi
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

echo "== installing worker dependencies"
(cd "$REPO_DIR" && PATH="$(dirname "$NODE"):$PATH" npm ci --omit=dev -w worker --include-workspace-root=false --no-audit --no-fund)

if [ ! -f "$WORKER_DIR/.env" ]; then
  cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
  chmod 600 "$WORKER_DIR/.env"
  echo "== created $WORKER_DIR/.env — set SERVER_URL and WORKER_TOKEN, then re-run this script"
  exit 0
fi
chmod 600 "$WORKER_DIR/.env"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__WORKER_DIR__#$WORKER_DIR#g" -e "s#__LOG_DIR__#$LOG_DIR#g" \
    -e "s#__PATH__#$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin#g" \
    "$WORKER_DIR/macos/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

echo "== (re)loading LaunchAgent"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout is asynchronous; bootstrap fails with EIO if the old job is still unloading.
for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
for attempt in 1 2 3; do
  launchctl bootstrap "$DOMAIN" "$PLIST" && break
  [ "$attempt" = 3 ] && { echo "launchctl bootstrap failed" >&2; exit 1; }
  sleep 2
done

echo "== keeping the Mac awake on power (display sleep unchanged)"
if sudo -n true 2>/dev/null; then
  sudo pmset -c sleep 0 disksleep 0
else
  echo "   run once yourself:  sudo pmset -c sleep 0 disksleep 0"
fi

sleep 2
"$NODE" "$WORKER_DIR/bin/darkroom-worker.js" status || true
echo "== log: $LOG_DIR/worker.log"
