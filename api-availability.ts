// Pure helpers for interpreting the GetAvailableTeeTimes API payload.
//
// These live in their own module (no Playwright / fs / dotenv side effects) so the
// range + availability logic can be unit tested against real-world payload shapes.

export interface TeeSheetSlot {
  teeTime?: string | null;
  availPlayers?: number | null;
  [key: string]: any;
}

export type ApiVerdict =
  | "available" // at least one slot in range can seat a full group
  | "all-booked" // every slot in range reports zero availability
  | "partial" // slots in range have some room, but never enough for a full group
  | "not-released" // the sheet (or our window of it) isn't on the tee sheet yet
  | "unknown"; // payload could not be interpreted - never trust this to stop retries

export type ClockConvention = "24-hour" | "12-hour" | "meridiem" | "indeterminate";

export interface NormalizedSlot {
  raw: string; // exactly what the API returned
  minutes: number | null; // minutes since midnight, null when unparseable
  availPlayers: number | null; // null when the field is missing/non-numeric
  index: number; // position in the original teeSheet array
}

export interface ApiEvaluation {
  verdict: ApiVerdict;
  reason: string;
  clock: ClockConvention;
  slots: NormalizedSlot[];
  inRange: NormalizedSlot[];
  unparsed: NormalizedSlot[];
  diagnostics: string[];
}

const MERIDIEM_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i;
const BARE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ](\d{1,2}):(\d{2})/;

interface ParsedTime {
  hour: number;
  minute: number;
  /** true when the source string told us AM/PM (or was a 24h ISO timestamp) */
  absolute: boolean;
}

/**
 * Parse a single tee time string. Handles the formats this API family has been
 * seen to emit: "13:00", "13:00:00", "1:00 PM", "1:00PM", "2026-07-28T13:00:00".
 * Returns null (rather than NaN) for anything else so callers can react.
 */
export function parseTeeTime(raw: unknown): ParsedTime | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const iso = value.match(ISO_TIME);
  if (iso) {
    const hour = Number(iso[1]);
    const minute = Number(iso[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, absolute: true };
  }

  const meridiem = value.match(MERIDIEM_TIME);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const isPM = meridiem[4].toLowerCase() === "p";
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    return { hour, minute, absolute: true };
  }

  const bare = value.match(BARE_TIME);
  if (bare) {
    const hour = Number(bare[1]);
    const minute = Number(bare[2]);
    if (hour > 23 || minute > 59) return null;
    // A bare hour of 13+ can only be 24-hour; anything <= 12 is ambiguous until
    // we've seen the rest of the sheet (see normalizeTeeSheet).
    return { hour, minute, absolute: hour > 12 };
  }

  return null;
}

/**
 * Convert a whole tee sheet into minutes-since-midnight.
 *
 * The important case: a sheet that reports bare 12-hour times ("12:50", "1:00",
 * "3:40"). Parsed naively, the afternoon rows collapse to 1:00am/3:40am and drop
 * out of any afternoon time range, which silently hides available slots. Tee
 * sheets are chronological, so a decrease in the sequence means we crossed noon.
 */
export function normalizeTeeSheet(slots: TeeSheetSlot[]): {
  normalized: NormalizedSlot[];
  clock: ClockConvention;
} {
  const parsed = slots.map((slot, index) => ({
    index,
    raw: typeof slot?.teeTime === "string" ? slot.teeTime : String(slot?.teeTime ?? ""),
    time: parseTeeTime(slot?.teeTime),
    availPlayers:
      typeof slot?.availPlayers === "number" && Number.isFinite(slot.availPlayers)
        ? slot.availPlayers
        : null,
  }));

  const times = parsed.filter((p) => p.time !== null);
  const anyAbsolute = times.some((p) => p.time!.absolute);
  const anyAfternoonHour = times.some((p) => p.time!.hour > 12);

  let clock: ClockConvention;
  if (anyAbsolute && times.every((p) => p.time!.absolute)) {
    clock = anyAfternoonHour ? "24-hour" : "meridiem";
  } else if (anyAfternoonHour) {
    clock = "24-hour";
  } else {
    // Every hour is <= 12. If the sequence never goes backwards it reads the same
    // either way; if it does, it's a 12-hour sheet that needs a PM rollover.
    let previous = -1;
    let goesBackwards = false;
    for (const p of times) {
      const value = p.time!.hour * 60 + p.time!.minute;
      if (value < previous) {
        goesBackwards = true;
        break;
      }
      previous = value;
    }
    clock = goesBackwards ? "12-hour" : "indeterminate";
  }

  let pm = false;
  let previousMinutes = -1;
  const normalized: NormalizedSlot[] = parsed.map((p) => {
    if (!p.time) {
      return { raw: p.raw, minutes: null, availPlayers: p.availPlayers, index: p.index };
    }

    let minutes = p.time.hour * 60 + p.time.minute;

    if (clock === "12-hour" && !p.time.absolute) {
      const base = p.time.hour % 12;
      if (p.time.hour === 12) {
        // A tee sheet never runs at midnight, so 12:xx is noon and everything
        // after it is PM.
        pm = true;
        minutes = 12 * 60 + p.time.minute;
      } else if (pm) {
        minutes = (base + 12) * 60 + p.time.minute;
      } else {
        minutes = base * 60 + p.time.minute;
        if (minutes < previousMinutes) {
          pm = true;
          minutes = (base + 12) * 60 + p.time.minute;
        }
      }
    }

    previousMinutes = minutes;
    return { raw: p.raw, minutes, availPlayers: p.availPlayers, index: p.index };
  });

  return { normalized, clock };
}

export function parseRangeBoundary(timeStr: string): number {
  const parsed = parseTeeTime(timeStr);
  if (!parsed) throw new Error(`Unparseable time range boundary: ${timeStr}`);
  return parsed.hour * 60 + parsed.minute;
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "??:??";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// The window of times the course releases 1 day out. Used only to tell
// "the sheet isn't up yet" apart from "the sheet is up and full".
const RELEASE_WINDOW_START = 9 * 60 + 30;
const RELEASE_WINDOW_END = 11 * 60 + 20;

export interface EvaluateOptions {
  /** How many open seats a slot needs before we consider it bookable. */
  requiredPlayers?: number;
}

export function evaluateApiAvailability(
  timeRange: { start: string; end: string },
  apiResponse: any,
  options: EvaluateOptions = {}
): ApiEvaluation {
  const requiredPlayers = options.requiredPlayers ?? 4;
  const diagnostics: string[] = [];

  const teeSheet = apiResponse?.data?.teeSheet;
  if (!Array.isArray(teeSheet)) {
    const topLevel = apiResponse && typeof apiResponse === "object" ? Object.keys(apiResponse) : [];
    const dataKeys =
      apiResponse?.data && typeof apiResponse.data === "object" ? Object.keys(apiResponse.data) : [];
    diagnostics.push(
      `Payload has no data.teeSheet array (top-level keys: [${topLevel.join(", ")}], data keys: [${dataKeys.join(", ")}])`
    );
    return {
      verdict: "unknown",
      reason: "no-tee-sheet",
      clock: "indeterminate",
      slots: [],
      inRange: [],
      unparsed: [],
      diagnostics,
    };
  }

  const startNum = parseRangeBoundary(timeRange.start);
  const endNum = parseRangeBoundary(timeRange.end);

  const { normalized, clock } = normalizeTeeSheet(teeSheet);
  const unparsed = normalized.filter((s) => s.minutes === null);
  const parsed = normalized.filter((s) => s.minutes !== null);

  diagnostics.push(
    `Tee sheet: ${normalized.length} slots, clock detected as ${clock}` +
      (parsed.length
        ? `, span ${formatMinutes(parsed[0].minutes)}-${formatMinutes(parsed[parsed.length - 1].minutes)}` +
          ` (raw "${parsed[0].raw}" .. "${parsed[parsed.length - 1].raw}")`
        : "")
  );

  if (unparsed.length > 0) {
    const sample = unparsed
      .slice(0, 5)
      .map((s) => JSON.stringify(s.raw))
      .join(", ");
    diagnostics.push(`⚠️ ${unparsed.length} slot(s) had an unrecognised teeTime format: ${sample}`);
  }

  if (parsed.length === 0) {
    return {
      verdict: "unknown",
      reason: "no-parseable-times",
      clock,
      slots: normalized,
      inRange: [],
      unparsed,
      diagnostics,
    };
  }

  const inRange = parsed.filter((s) => s.minutes! >= startNum && s.minutes! <= endNum);

  diagnostics.push(
    `In range ${timeRange.start}-${timeRange.end}: ${inRange.length} slot(s)` +
      (inRange.length
        ? ` -> ${inRange
            .map((s) => `${formatMinutes(s.minutes)}(raw "${s.raw}", avail ${s.availPlayers ?? "?"})`)
            .join(", ")}`
        : "")
  );

  if (inRange.length === 0) {
    const hasReleaseWindow = parsed.some(
      (s) => s.minutes! >= RELEASE_WINDOW_START && s.minutes! <= RELEASE_WINDOW_END
    );
    diagnostics.push(
      `No slots in range; 1-day release window (09:30-11:20) ${hasReleaseWindow ? "is" : "is NOT"} on the sheet`
    );
    return {
      verdict: "not-released",
      reason: hasReleaseWindow ? "range-absent-from-sheet" : "sheet-not-released",
      clock,
      slots: normalized,
      inRange,
      unparsed,
      diagnostics,
    };
  }

  const unknownAvailability = inRange.filter((s) => s.availPlayers === null);
  if (unknownAvailability.length > 0) {
    diagnostics.push(
      `⚠️ ${unknownAvailability.length} in-range slot(s) had no numeric availPlayers - refusing to call the range booked`
    );
    return {
      verdict: "unknown",
      reason: "missing-avail-players",
      clock,
      slots: normalized,
      inRange,
      unparsed,
      diagnostics,
    };
  }

  const bookable = inRange.filter((s) => (s.availPlayers ?? 0) >= requiredPlayers);
  if (bookable.length > 0) {
    return {
      verdict: "available",
      reason: "open-slots",
      clock,
      slots: normalized,
      inRange,
      unparsed,
      diagnostics,
    };
  }

  const allBooked = inRange.every((s) => s.availPlayers === 0);
  return {
    verdict: allBooked ? "all-booked" : "partial",
    reason: allBooked ? "all-zero-avail" : "no-slot-seats-full-group",
    clock,
    slots: normalized,
    inRange,
    unparsed,
    diagnostics,
  };
}
