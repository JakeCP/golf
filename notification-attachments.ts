export interface ScreenshotCandidate {
  name: string;
  mtimeMs: number;
}

const DISCORD_CONTENT_LIMIT = 2_000;
const TRUNCATION_NOTICE = "\n\n[Details truncated; full error is in the Mac Mini log.]";

/** Keep failure notifications within Discord's message-content limit. */
export function truncateDiscordContent(
  content: string,
  limit = DISCORD_CONTENT_LIMIT
): string {
  if (content.length <= limit) return content;
  if (limit <= TRUNCATION_NOTICE.length) return content.slice(0, limit);
  return content.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

/** Select newest Discord screenshots that were created by this worker run. */
export function selectRunScreenshots(
  candidates: ScreenshotCandidate[],
  runStartedAtMs: number,
  limit = 10
): ScreenshotCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.name.toLowerCase().endsWith(".png") &&
        candidate.mtimeMs >= runStartedAtMs
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}
