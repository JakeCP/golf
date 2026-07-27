import { describe, it, expect } from "vitest";
import {
  evaluateApiAvailability,
  normalizeTeeSheet,
  parseTeeTime,
  TeeSheetSlot,
} from "./api-availability";

const sheet = (rows: Array<[string, number | null | undefined]>): any => ({
  data: {
    teeSheet: rows.map(([teeTime, availPlayers]) => {
      const slot: TeeSheetSlot = { teeTime };
      if (availPlayers !== undefined) slot.availPlayers = availPlayers;
      return slot;
    }),
  },
});

const afternoon = { start: "12:30", end: "15:00" };

describe("parseTeeTime", () => {
  it("parses 24-hour times with and without seconds", () => {
    expect(parseTeeTime("13:00")).toEqual({ hour: 13, minute: 0, absolute: true });
    expect(parseTeeTime("09:30:00")).toEqual({ hour: 9, minute: 30, absolute: false });
  });

  it("parses meridiem times", () => {
    expect(parseTeeTime("1:00 PM")).toEqual({ hour: 13, minute: 0, absolute: true });
    expect(parseTeeTime("12:50PM")).toEqual({ hour: 12, minute: 50, absolute: true });
    expect(parseTeeTime("12:10 a.m.")).toEqual({ hour: 0, minute: 10, absolute: true });
  });

  it("parses ISO timestamps without shifting the clock", () => {
    expect(parseTeeTime("2026-07-28T13:40:00")).toEqual({
      hour: 13,
      minute: 40,
      absolute: true,
    });
  });

  it("returns null instead of NaN for junk", () => {
    expect(parseTeeTime("")).toBeNull();
    expect(parseTeeTime(null)).toBeNull();
    expect(parseTeeTime(1300 as any)).toBeNull();
    expect(parseTeeTime("noon")).toBeNull();
  });
});

describe("normalizeTeeSheet", () => {
  it("rolls a bare 12-hour sheet over at noon", () => {
    const { normalized, clock } = normalizeTeeSheet(
      ["7:50", "11:30", "12:00", "12:50", "1:00", "3:40"].map((teeTime) => ({ teeTime }))
    );
    expect(clock).toBe("12-hour");
    expect(normalized.map((s) => s.minutes)).toEqual([
      7 * 60 + 50,
      11 * 60 + 30,
      12 * 60,
      12 * 60 + 50,
      13 * 60,
      15 * 60 + 40,
    ]);
  });

  it("leaves a 24-hour sheet alone", () => {
    const { normalized, clock } = normalizeTeeSheet(
      ["07:50", "12:50", "13:00", "15:40"].map((teeTime) => ({ teeTime }))
    );
    expect(clock).toBe("24-hour");
    expect(normalized.map((s) => s.minutes)).toEqual([470, 770, 780, 940]);
  });
});

describe("evaluateApiAvailability", () => {
  it("finds an open afternoon slot on a 24-hour sheet", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:30", 0],
        ["12:50", 0],
        ["13:00", 4],
      ])
    );
    expect(result.verdict).toBe("available");
  });

  // Regression: a bare 12-hour sheet used to parse "1:00" as 1am, drop it out of a
  // 12:30-15:00 range, and report the range as fully booked while 1:00 PM sat open.
  it("finds an open afternoon slot on a bare 12-hour sheet", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["9:30", 0],
        ["11:30", 0],
        ["12:30", 0],
        ["12:40", 0],
        ["12:50", 0],
        ["1:00", 4],
        ["1:10", 4],
        ["3:40", 2],
      ])
    );
    expect(result.verdict).toBe("available");
    expect(result.clock).toBe("12-hour");
    // 3:40 PM normalises to 15:40, which is past the 15:00 end of the range
    expect(result.inRange.map((s) => s.raw)).toEqual([
      "12:30",
      "12:40",
      "12:50",
      "1:00",
      "1:10",
    ]);
  });

  it("finds an open afternoon slot on a meridiem sheet", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:50 PM", 0],
        ["1:00 PM", 4],
      ])
    );
    expect(result.verdict).toBe("available");
  });

  it("reports all-booked only when every in-range slot is at zero", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["9:30", 4],
        ["12:30", 0],
        ["1:00", 0],
        ["3:40", 0],
      ])
    );
    expect(result.verdict).toBe("all-booked");
    expect(result.inRange.map((s) => s.raw)).toEqual(["12:30", "1:00"]);
  });

  it("separates partial availability from all-booked", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:30", 0],
        ["1:00", 2],
      ])
    );
    expect(result.verdict).toBe("partial");
  });

  it("honours a smaller group size when asked", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:30", 0],
        ["1:00", 2],
      ]),
      { requiredPlayers: 2 }
    );
    expect(result.verdict).toBe("available");
  });

  it("reports not-released when the sheet has no slots in range", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["9:30", 4],
        ["11:00", 4],
      ])
    );
    expect(result.verdict).toBe("not-released");
    expect(result.reason).toBe("range-absent-from-sheet");
  });

  it("never claims booked when teeTime cannot be parsed", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["not-a-time", 0],
        ["also junk", 0],
      ])
    );
    expect(result.verdict).toBe("unknown");
    expect(result.diagnostics.join(" ")).toContain("unrecognised teeTime format");
  });

  it("never claims booked when availPlayers is missing", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:30", undefined],
        ["1:00", undefined],
      ])
    );
    expect(result.verdict).toBe("unknown");
    expect(result.reason).toBe("missing-avail-players");
  });

  it("never claims booked when the payload shape is unexpected", () => {
    const result = evaluateApiAvailability(afternoon, { data: { teeTimes: [] } });
    expect(result.verdict).toBe("unknown");
    expect(result.reason).toBe("no-tee-sheet");
    expect(result.diagnostics.join(" ")).toContain("data keys: [teeTimes]");
  });

  it("logs the in-range slots it evaluated", () => {
    const result = evaluateApiAvailability(
      afternoon,
      sheet([
        ["12:30", 0],
        ["1:00", 4],
      ])
    );
    expect(result.diagnostics.join("\n")).toContain('13:00(raw "1:00", avail 4)');
  });
});
