export interface ScreenshotCandidate {
  name: string;
  mtimeMs: number;
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
