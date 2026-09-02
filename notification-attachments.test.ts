import { describe, expect, it } from "vitest";
import { selectRunScreenshots } from "./notification-attachments";

describe("Discord screenshot selection", () => {
  const runStartedAtMs = 10_000;

  it("does not attach screenshots left over from earlier runs", () => {
    const selected = selectRunScreenshots(
      [
        { name: "success-yesterday.png", mtimeMs: 9_000 },
        { name: "failure-last-week.png", mtimeMs: 1_000 },
      ],
      runStartedAtMs
    );

    expect(selected).toEqual([]);
  });

  it("attaches only current-run PNGs, newest first", () => {
    const selected = selectRunScreenshots(
      [
        { name: "current-first.png", mtimeMs: 10_100 },
        { name: "worker.log", mtimeMs: 10_300 },
        { name: "CURRENT-SECOND.PNG", mtimeMs: 10_200 },
        { name: "old.png", mtimeMs: 9_999 },
      ],
      runStartedAtMs
    );

    expect(selected.map(({ name }) => name)).toEqual([
      "CURRENT-SECOND.PNG",
      "current-first.png",
    ]);
  });

  it("respects Discord's ten-attachment limit", () => {
    const selected = selectRunScreenshots(
      Array.from({ length: 12 }, (_, index) => ({
        name: `current-${index}.png`,
        mtimeMs: runStartedAtMs + index,
      })),
      runStartedAtMs
    );

    expect(selected).toHaveLength(10);
    expect(selected[0].name).toBe("current-11.png");
  });
});
