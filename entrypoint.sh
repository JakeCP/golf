#!/bin/bash
# Render cron entrypoint. Pulls the latest booking-queue.json from GitHub,
# runs the booking script, then pushes any queue changes back so the GitHub
# repo stays the source of truth (same UX as the prior auto-commit Action).
set -euo pipefail

: "${GITHUB_PUSH_TOKEN:?GITHUB_PUSH_TOKEN is required (PAT with repo write scope)}"
: "${GITHUB_REPO:?GITHUB_REPO is required, e.g. JakeCP/golf}"
GIT_BRANCH="${GIT_BRANCH:-main}"

REPO_DIR="$(mktemp -d)"
trap 'rm -rf "$REPO_DIR"' EXIT

echo "[entrypoint] Cloning ${GITHUB_REPO}@${GIT_BRANCH} for queue state..."
git clone --depth 1 --branch "$GIT_BRANCH" \
    "https://x-access-token:${GITHUB_PUSH_TOKEN}@github.com/${GITHUB_REPO}.git" \
    "$REPO_DIR"

cp "$REPO_DIR/booking-queue.json" /app/booking-queue.json

echo "[entrypoint] Running booking script..."
# `|| SCRIPT_EXIT=$?` keeps `set -e` from aborting the entrypoint when the
# script fails: the queue sync below must still run, because statuses the
# script recorded before failing would otherwise be lost.
SCRIPT_EXIT=0
IS_SCHEDULED_RUN=true npx ts-node /app/process-queue.ts || SCRIPT_EXIT=$?

# Sync queue state back to GitHub. The frontend commits to the same branch
# (users add/delete requests from the web UI), so a run that takes 10+ minutes
# can race those commits and get a non-fast-forward rejection. Each attempt
# rebuilds our commit on top of the latest remote state, merging the remote
# queue with our post-run queue via merge-queue.js, then retries the push.
sync_queue() {
    cd "$REPO_DIR"
    local attempt
    for attempt in 1 2 3 4 5; do
        git fetch origin "$GIT_BRANCH"
        git reset --hard "origin/${GIT_BRANCH}"
        node /app/merge-queue.js booking-queue.json /app/booking-queue.json \
            > /tmp/merged-queue.json
        cp /tmp/merged-queue.json booking-queue.json
        git add booking-queue.json
        if git diff --cached --quiet; then
            echo "[entrypoint] No queue changes to push."
            return 0
        fi
        git -c user.email="bot@render.local" -c user.name="Render Bot" \
            commit -m "Update booking queue after processing"
        if git push origin "HEAD:${GIT_BRANCH}"; then
            echo "[entrypoint] Pushed queue update (attempt ${attempt})."
            return 0
        fi
        echo "[entrypoint] Push rejected (attempt ${attempt}); retrying against latest remote..."
        sleep $((2 * attempt))
    done
    echo "[entrypoint] ERROR: could not push queue update after 5 attempts."
    return 1
}

echo "[entrypoint] Syncing queue state back to ${GITHUB_REPO}@${GIT_BRANCH}..."
SYNC_EXIT=0
sync_queue || SYNC_EXIT=$?

if [ "$SCRIPT_EXIT" -ne 0 ]; then
    exit "$SCRIPT_EXIT"
fi
exit "$SYNC_EXIT"
