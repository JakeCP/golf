#!/bin/bash
# Render cron entrypoint. Pulls the latest booking-queue.json from GitHub,
# runs the booking script, then pushes any queue changes back so the GitHub
# repo stays the source of truth (same UX as the prior auto-commit Action).
set -euo pipefail

: "${GITHUB_REPO:?GITHUB_REPO is required, e.g. JakeCP/golf}"
GIT_BRANCH="${GIT_BRANCH:-main}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# One-shot credential handoff used during the Render-to-Mac migration. Render
# encrypts its existing webhook to an ephemeral public key and writes only the
# ciphertext back to GitHub. The private key never leaves the migration host.
if [[ "${RENDER:-}" == "true" && -f "$APP_DIR/render-migration-public.pem" ]]; then
    : "${GITHUB_PUSH_TOKEN:?GITHUB_PUSH_TOKEN is required for credential migration}"
    : "${DISCORD_WEBHOOK_URL:?DISCORD_WEBHOOK_URL is required for credential migration}"

    REPO_DIR="$(mktemp -d)"
    trap 'rm -rf "$REPO_DIR"' EXIT
    git clone --depth 1 --branch "$GIT_BRANCH" \
        "https://x-access-token:${GITHUB_PUSH_TOKEN}@github.com/${GITHUB_REPO}.git" \
        "$REPO_DIR"

    if [[ ! -f "$REPO_DIR/.discord-webhook.enc" ]]; then
        MIGRATION_KEY="$APP_DIR/render-migration-public.pem" \
        MIGRATION_OUTPUT="$REPO_DIR/.discord-webhook.enc" \
        node -e '
          const fs = require("fs");
          const crypto = require("crypto");
          const publicKey = fs.readFileSync(process.env.MIGRATION_KEY, "utf8");
          const encrypted = crypto.publicEncrypt(
            {
              key: publicKey,
              padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(process.env.DISCORD_WEBHOOK_URL, "utf8")
          );
          fs.writeFileSync(
            process.env.MIGRATION_OUTPUT,
            encrypted.toString("base64") + "\n",
            { mode: 0o600 }
          );
        '
        cd "$REPO_DIR"
        git add .discord-webhook.enc
        git -c user.email="bot@render.local" -c user.name="Render Credential Migrator" \
            commit -m "Return encrypted booking notification credential"
        git push origin "HEAD:${GIT_BRANCH}"
        echo "[entrypoint] Encrypted credential handoff complete."
    else
        echo "[entrypoint] Encrypted credential handoff already exists."
    fi
    exit 0
fi

# The booking worker was migrated from Render to the Mac Mini. Render exposes
# RENDER=true to all of its services, so an old cron resource can safely remain
# provisioned without racing the Mini and attempting the same booking twice.
if [[ "${RENDER:-}" == "true" && "${ALLOW_RENDER_BOOKING:-}" != "true" ]]; then
    echo "[entrypoint] Render runner is disabled; the Mac Mini is authoritative."
    exit 0
fi

REPO_DIR="$(mktemp -d)"
trap 'rm -rf "$REPO_DIR"' EXIT

echo "[entrypoint] Cloning ${GITHUB_REPO}@${GIT_BRANCH} for queue state..."
if [[ -n "${GITHUB_PUSH_TOKEN:-}" ]]; then
    CLONE_URL="https://x-access-token:${GITHUB_PUSH_TOKEN}@github.com/${GITHUB_REPO}.git"
else
    # Native hosts can use a private git credential helper instead of putting a
    # token in the process environment. The repository is public for cloning;
    # the helper is consulted when the queue update is pushed.
    CLONE_URL="https://github.com/${GITHUB_REPO}.git"
fi
git clone --depth 1 --branch "$GIT_BRANCH" "$CLONE_URL" "$REPO_DIR"

cp "$REPO_DIR/booking-queue.json" "$APP_DIR/booking-queue.json"

echo "[entrypoint] Running booking script..."
# `set -e` would abort here on a non-zero exit and skip the sync-back below,
# so the failure has to be captured explicitly.
set +e
cd "$APP_DIR"
IS_SCHEDULED_RUN=true ./node_modules/.bin/ts-node process-queue.ts
SCRIPT_EXIT=$?
set -e

# Always attempt to sync state back, even on script failure (the script may
# have moved some requests to processedRequests before the failure).
echo "[entrypoint] Syncing queue state back to ${GITHUB_REPO}@${GIT_BRANCH}..."
cp "$APP_DIR/booking-queue.json" "$REPO_DIR/booking-queue.json"
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
