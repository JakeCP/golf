# Render setup

End-to-end walkthrough for deploying the booking cron on Render. Total time: ~20 minutes.

## 1. Create a GitHub Personal Access Token (5 min)

`entrypoint.sh` clones the repo at runtime and pushes the updated `booking-queue.json` back. It needs a token with write access.

1. Go to https://github.com/settings/personal-access-tokens/new (fine-grained PAT).
2. **Token name:** `render-golf-booking`.
3. **Expiration:** 1 year (Render won't auto-rotate; set a calendar reminder).
4. **Repository access:** Only select repositories → pick `JakeCP/golf`.
5. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - (leave the rest at "No access")
6. Click **Generate token**, copy the value (`github_pat_...`). You won't see it again.

## 2. Deploy on Render (10 min)

Two options. The Blueprint flow reads `render.yaml` from the repo and provisions everything in one click.

### Option A — Blueprint (recommended)

1. Render dashboard → **New** → **Blueprint**.
2. Connect your GitHub account if not already, pick `JakeCP/golf`.
3. Render auto-detects `render.yaml` and shows a preview: one cron job named `golf-booking`.
4. Render will prompt for the env vars marked `sync: false` in `render.yaml`. Paste:
   - `GOLF_USERNAME` — same as today's GitHub secret
   - `GOLF_PASSWORD` — same
   - `GOOGLE_AI_API_KEY` — same
   - `DISCORD_WEBHOOK_URL` — same
   - `GITHUB_PUSH_TOKEN` — the PAT from step 1
5. Click **Apply**. Render starts the first build (~3–4 min for the Docker image).

### Option B — Manual cron job

1. Render dashboard → **New** → **Cron Job**.
2. Connect repo `JakeCP/golf`, branch `main`.
3. **Runtime:** Docker. Render auto-detects the `Dockerfile`.
4. **Schedule (UTC):** `50 10 * * *` (06:50 EDT — same window as today).
5. **Environment variables:** add all six from step 4 of Option A, plus:
   - `GITHUB_REPO=JakeCP/golf`
   - `GIT_BRANCH=main`
6. **Create Cron Job**.

## 3. Verify the first run (5 min)

1. In the Render dashboard for the cron job, click **Trigger Run**.
2. Tail the logs in the dashboard. You should see:
   ```
   [entrypoint] Cloning JakeCP/golf@main for queue state...
   [entrypoint] Running booking script...
   [...] Starting booking queue processing
   [...] Found N requests for today    OR    No booking requests for today
   [...] Discord notification sent (status 204, K attachments)
   [entrypoint] Syncing queue state back...
   [entrypoint] No queue changes to push     OR    Pushed queue update.
   ```
3. Check Discord — the run summary message should appear, same format as before.
4. If the run made bookings, check that `booking-queue.json` on `main` has the updated `processedRequests` (commit author will be `Render Bot`).

## 4. Disable the GitHub Actions cron (1 min)

Once you've confirmed Render is working end-to-end, the old workflow file is already removed in this PR — nothing more to do. If you want to disable the workflow before merging, go to **Repo → Actions → Process Golf Booking Queue → … → Disable workflow**.

## 5. Adding new booking requests

No change from today: edit `booking-queue.json` on `main` (via the web UI in `docs/` or by committing directly). Render's next scheduled run will pick it up via `git pull`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails: `mcr.microsoft.com/playwright:v1.55.0-jammy not found` | Playwright tag bumped/removed | Update the `FROM` line in `Dockerfile` to a current tag |
| Run fails with `GITHUB_PUSH_TOKEN is required` | Env var not set on Render | Add it via Render dashboard → Environment |
| Run fails with `remote: Permission to JakeCP/golf.git denied` | PAT scope wrong, or expired | Regenerate PAT with `Contents: Read and write` |
| Discord message never arrives | `DISCORD_WEBHOOK_URL` env var missing or webhook deleted | Check the URL works with `curl -X POST -H "Content-Type: application/json" -d '{"content":"test"}' "$URL"` |
| Booking script runs but slots are gone | Render cron firing late? unlikely — check logs for actual start time | If it really happens, adjust the cron in `render.yaml` to fire earlier |

## Costs

Render Cron Jobs: $1/month flat (Starter plan, 400 build-min and unlimited cron runs included).

## Rotating the PAT

When the GitHub PAT nears expiry: regenerate at https://github.com/settings/personal-access-tokens, then in Render dashboard → cron job → **Environment** → update `GITHUB_PUSH_TOKEN` → **Save Changes**. No redeploy needed; the new value is picked up on the next run.
