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
IS_SCHEDULED_RUN=true npx ts-node /app/process-queue.ts
SCRIPT_EXIT=$?

# Always attempt to sync state back, even on script failure (the script may
# have moved some requests to processedRequests before the failure).
echo "[entrypoint] Syncing queue state back to ${GITHUB_REPO}@${GIT_BRANCH}..."
cp /app/booking-queue.json "$REPO_DIR/booking-queue.json"
cd "$REPO_DIR"
git add booking-queue.json
if ! git diff --cached --quiet; then
    git -c user.email="bot@render.local" -c user.name="Render Bot" \
        commit -m "Update booking queue after processing"
    git push origin "HEAD:${GIT_BRANCH}"
    echo "[entrypoint] Pushed queue update."
else
    echo "[entrypoint] No queue changes to push."
fi

exit "$SCRIPT_EXIT"
