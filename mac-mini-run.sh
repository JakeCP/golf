#!/bin/bash
# Scheduled native runner for the dedicated golfbot account on the Mac Mini.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$APP_DIR/.run-lock"

# launchd starts with a minimal PATH and does not load the account's nvm setup.
export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
fi

if [[ -f "$APP_DIR/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    . "$APP_DIR/.env"
    set +a
fi

# DATE_OVERRIDE is useful for local debugging but must never leak into a real
# scheduled run. The queue's release dates must be evaluated against today.
unset DATE_OVERRIDE TEST_MODE SIMULATE_BOOKING
export HEADLESS=true
export PLAYWRIGHT_EXECUTABLE_PATH="${PLAYWRIGHT_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

export APP_DIR
export GITHUB_REPO="${GITHUB_REPO:-JakeCP/golf}"
export GIT_BRANCH="${GIT_BRANCH:-main}"
export BOOKING_RUNNER_ID="mac-mini"
export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-$HOME/.config/golf-booker/gitconfig}"

mkdir -p "$APP_DIR/logs"

# Prevent a manual run from overlapping the scheduler. Recover automatically from a
# stale PID left behind if the machine or process stopped unexpectedly.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_PID="$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "[mac-mini-run] Booking worker is already running as PID $LOCK_PID; skipping."
        exit 0
    fi
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || {
        echo "[mac-mini-run] Could not recover stale lock at $LOCK_DIR" >&2
        exit 1
    }
    mkdir "$LOCK_DIR"
fi

echo "$$" > "$LOCK_DIR/pid"
cleanup_lock() {
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_lock EXIT INT TERM

"$APP_DIR/entrypoint.sh"
