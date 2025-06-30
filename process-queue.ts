import * as fs from "fs";
import * as path from "path";
import { chromium, Page, Browser, Frame } from "@playwright/test";
import { WriteStream } from "fs";
import * as dotenv from "dotenv";
import * as https from "https";

dotenv.config();

// Types
interface TimeRange {
  start: string;
  end: string;
}

interface BookingRequest {
  id: string;
  requestDate: string;
  playDate: string;
  timeRange: TimeRange;
  status: "pending" | "success" | "failed" | "error";
  requestedBy: string;
  processedDate?: string;
  bookedTime?: string;
  confirmationNumber?: string;
  failureReason?: string;
}

interface QueueData {
  bookingRequests: BookingRequest[];
  processedRequests: BookingRequest[];
}

type Slot = { time: string; id: string };

// Configuration
const headless = process.env.HEADLESS !== "false";
const takeScreenshots = process.env.TAKE_SCREENSHOTS !== "false";
const queueFilePath = path.join(__dirname, "booking-queue.json");

// Logging setup
const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logFilePath = path.join(
  logDir,
  `processing-${new Date().toISOString().replace(/:/g, "-")}.log`
);
const logStream: WriteStream = fs.createWriteStream(logFilePath, {
  flags: "a",
});

const log = (message: string): void => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  logStream.write(logMessage + "\n");
};

const setOutput = (name: string, value: string) => {
  const dest = process.env.GITHUB_OUTPUT;
  if (dest) {
    fs.appendFileSync(dest, `${name}<<EOF\n${value}\nEOF\n`);
  } else {
    console.log(`${name}=${value}`);
  }
};

// Date helpers
const getTodayDate = (): string => {
  if (process.env.DATE_OVERRIDE) {
    log(`Using date override: ${process.env.DATE_OVERRIDE}`);
    return process.env.DATE_OVERRIDE;
  }
  const estDate = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
  });
  const dateObj = new Date(estDate);
  const year = dateObj.getFullYear();
  const month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
  const day = dateObj.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getCurrentTimeET = (): string => {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

// Sleep until specific time function
const sleepUntilTimeInZone = async (
  targetHour24: number,
  targetMinute: number,
  timeZoneIANA = "America/New_York"
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const calculateDelay = () => {
      try {
        const now = new Date();

        const offsetFormatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timeZoneIANA,
          timeZoneName: "longOffset",
        });
        const offsetParts = offsetFormatter.formatToParts(now);
        const offsetStringPart = offsetParts.find(
          (part) => part.type === "timeZoneName"
        );

        if (!offsetStringPart) {
          throw new Error(
            `Could not determine timezone offset for '${timeZoneIANA}'`
          );
        }
        const offsetString = offsetStringPart.value;

        const offsetMatch = offsetString.match(
          /GMT([+-])(\d{1,2})(?::(\d{2}))?/
        );
        if (!offsetMatch) {
          throw new Error(`Could not parse offset string: '${offsetString}'`);
        }

        const offsetSign = offsetMatch[1] === "+" ? 1 : -1;
        const offsetHours = parseInt(offsetMatch[2], 10);
        const offsetRuleMinutes = offsetMatch[3]
          ? parseInt(offsetMatch[3], 10)
          : 0;
        const totalOffsetMinutes =
          offsetSign * (offsetHours * 60 + offsetRuleMinutes);

        const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
          timeZone: timeZoneIANA,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const currentDatePartsInZone = ymdFormatter
          .formatToParts(now)
          .reduce<{ [key: string]: number }>((acc, part) => {
            if (part.type !== "literal" && part.type !== "timeZoneName") {
              acc[part.type] = parseInt(part.value, 10);
            }
            return acc;
          }, {});

        let targetDateAttempt = new Date(
          Date.UTC(
            currentDatePartsInZone.year,
            currentDatePartsInZone.month - 1,
            currentDatePartsInZone.day,
            targetHour24,
            targetMinute,
            0,
            0
          )
        );

        targetDateAttempt.setUTCMinutes(
          targetDateAttempt.getUTCMinutes() - totalOffsetMinutes
        );

        if (targetDateAttempt.getTime() <= now.getTime()) {
          return 0;
        }

        const msUntilTarget = targetDateAttempt.getTime() - now.getTime();
        return msUntilTarget > 0 ? msUntilTarget : 0;
      } catch (error) {
        console.error("Error in calculateDelay:", error);
        reject(error);
        return -1; // Signal error to caller
      }
    };

    let delay = calculateDelay();

    // Fallback for DST edge cases - use simpler calculation if main logic fails
    if (delay === -1) {
      console.log("Primary timezone calculation failed, using fallback method");
      try {
        const now = new Date();
        const todayInZone = new Date(
          now.toLocaleString("en-US", { timeZone: timeZoneIANA })
        );
        const targetTime = new Date(todayInZone);
        targetTime.setHours(targetHour24, targetMinute, 0, 0);

        // If target time is in the past, it's for tomorrow
        if (targetTime.getTime() <= now.getTime()) {
          delay = 0;
        } else {
          delay = targetTime.getTime() - now.getTime();
        }
      } catch (fallbackError) {
        console.error(
          "Fallback timezone calculation also failed:",
          fallbackError
        );
        reject(fallbackError);
        return;
      }
    }

    if (delay <= 0) {
      console.log(
        `Target time ${String(targetHour24).padStart(2, "0")}:${String(
          targetMinute
        ).padStart(
          2,
          "0"
        )} in ${timeZoneIANA} is in the past or now. Resolving immediately.`
      );
      resolve();
      return;
    }

    const targetActualDate = new Date(Date.now() + delay);
    console.log(
      `Waiting for ${delay}ms (until approximately ${targetActualDate.toLocaleString(
        "en-US",
        {
          timeZone: timeZoneIANA,
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }
      )} in ${timeZoneIANA})`
    );
    setTimeout(() => {
      console.log(
        `Reached target time: ${String(targetHour24).padStart(2, "0")}:${String(
          targetMinute
        ).padStart(2, "0")} in ${timeZoneIANA}`
      );
      resolve();
    }, delay);
  });
};

// Queue management
async function initializeQueue(): Promise<QueueData> {
  if (!fs.existsSync(queueFilePath)) {
    log(`No booking queue file found. Creating empty queue.`);
    const emptyQueue: QueueData = {
      bookingRequests: [],
      processedRequests: [],
    };
    fs.writeFileSync(queueFilePath, JSON.stringify(emptyQueue, null, 2));
    return emptyQueue;
  }
  return JSON.parse(fs.readFileSync(queueFilePath, "utf8"));
}

function filterTodayRequests(queueData: QueueData): BookingRequest[] {
  const today = getTodayDate();
  const thirtyDaysFromToday = new Date(today);
  thirtyDaysFromToday.setDate(thirtyDaysFromToday.getDate() + 21);
  const thirtyDaysString = thirtyDaysFromToday.toISOString().split("T")[0];

  const threeDaysAfter = new Date(today);
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3);
  const threeDaysString = threeDaysAfter.toISOString().split("T")[0];

  const filteredRequests = queueData.bookingRequests.filter((request) => {
    if (request.status !== "pending") return false;
    const isExactly30Days = request.playDate === thirtyDaysString;
    const isWithin3Days =
      request.playDate >= today && request.playDate <= threeDaysString;
    return isExactly30Days || isWithin3Days;
  });

  return filteredRequests.sort((a, b) => b.playDate.localeCompare(a.playDate));
}

const getFullIsoDateString = (dateStr: string): string => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const dateObj = new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
  return dateObj.toISOString();
};

const isWithinThreeDaysBooking = (playDate: string): boolean => {
  const today = getTodayDate();
  const threeDaysAfter = new Date(today);
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3);
  const threeDaysString = threeDaysAfter.toISOString().split("T")[0];
  return playDate >= today && playDate <= threeDaysString;
};

// Session storage helper
const setDateInSessionStorage = async (
  page: Page,
  playDate: string
): Promise<void> => {
  const isoDateStr = getFullIsoDateString(playDate);

  log(`Setting date ${playDate} in sessionStorage`);
  await page.addInitScript(
    ({ v }) => {
      sessionStorage.setItem("CHO.TT.selectedDate", `"${v}"`);
    },
    { v: isoDateStr }
  );
};

// Browser authentication - only done once
async function performInitialLogin(page: Page): Promise<void> {
  log("Performing initial login to golf course website");
  const username = process.env.GOLF_USERNAME;
  const password = process.env.GOLF_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Golf course credentials not found in environment variables"
    );
  }

  // Set up response monitoring for rate limiting
  page.on("response", (response) => {
    if (response.status() === 429) {
      log(`🚨 RATE LIMITED: ${response.status()} on ${response.url()}`);
    } else if (response.status() >= 500) {
      log(`⚠️ SERVER ERROR: ${response.status()} on ${response.url()}`);
    } else if (response.status() === 403) {
      log(`🔒 FORBIDDEN: ${response.status()} on ${response.url()}`);
    }
  });

  await page.goto(
    "https://lorabaygolf.clubhouseonline-e3.com/TeeTimes/TeeSheet.aspx"
  );
  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForLoadState("networkidle");
  log(`Logged in at ${getCurrentTimeET()}`);
}

// Navigate to booking page for subsequent requests
async function navigateToBookingPage(
  page: Page,
  playDate: string
): Promise<void> {
  log(`Navigating to booking page for ${playDate}`);
  await setDateInSessionStorage(page, playDate);
  await page.goto(
    "https://lorabaygolf.clubhouseonline-e3.com/TeeTimes/TeeSheet.aspx"
  );
  await page.waitForLoadState("networkidle");
}

async function getBookingFrame(page: Page): Promise<Frame> {
  const iframeHandle = await page.locator("iframe#module").elementHandle();
  if (!iframeHandle) throw new Error("Booking iframe not found");
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error("Unable to resolve content frame");
  return frame;
}

// Fallback date selection with clicking
async function selectDateWithClick(
  frame: Frame,
  targetDateText: string
): Promise<boolean> {
  try {
    log(`Attempting to select date "${targetDateText}" by clicking`);

    const clicked = await frame.evaluate((dateText: string) => {
      const dateElements = document.querySelectorAll(
        "div.item.ng-scope.slick-slide"
      );
      for (const el of dateElements) {
        const dateDiv = el.querySelector("div.date.ng-binding");
        if (dateDiv?.textContent?.trim().includes(dateText)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, targetDateText);

    if (!clicked) return false;

    // Wait for date to be selected
    const selector = `div.item.ng-scope.slick-slide.date-selected:has(div.date.ng-binding:text-is("${targetDateText}"))`;
    await frame.waitForSelector(selector, { timeout: 3000 });

    // Wait for golf course element
    await frame.waitForSelector(
      'div.input-wpr:has(label:text-is("Golf Course")) div.input:text-is("Lora Bay")',
      { timeout: 3000 }
    );

    return true;
  } catch (error) {
    log(`Failed to select date by clicking: ${error}`);
    return false;
  }
}

async function checkPageState(
  frame: Frame,
  playDate: string
): Promise<"ready" | "too-early" | "no-results" | "loading"> {
  try {
    const pageText = await frame.evaluate(() => document.body.innerText);

    // Check for rate limiting indicators
    if (
      pageText.includes("rate limit") ||
      pageText.includes("too many requests") ||
      pageText.includes("please wait") ||
      pageText.includes("temporarily unavailable")
    ) {
      log(
        `🚨 POTENTIAL RATE LIMITING DETECTED: Page contains rate limiting text`
      );
    }

    // Check if we're too early
    const datePattern = new Date(playDate).toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const tooEarlyPattern = `will become available on ${datePattern} at 7:00 AM`;
    if (pageText.includes(tooEarlyPattern)) {
      return "too-early";
    }

    // Check if we got the "no times" message (which might mean still loading)
    if (pageText.includes("Your search returned no times to be displayed")) {
      return "no-results";
    }

    // Check if there are actual time slots visible
    const hasTimeSlots = await frame.evaluate(() => {
      const slots = document.querySelectorAll(
        "div.flex-row.ng-scope div.time.ng-binding"
      );
      return slots.length > 0;
    });

    if (hasTimeSlots) {
      return "ready";
    }

    // No clear indicator - might still be loading
    return "loading";
  } catch (error) {
    log(`Error checking page state: ${error}`);
    return "loading";
  }
}

// Find available slots with retry for 30-day bookings (frame-based retries)
async function findAvailableSlots30Day(
  frame: Frame,
  timeRange: TimeRange,
  playDate: string,
  maxRetries = 30
): Promise<{ slots: Array<Slot>; updatedFrame: Frame }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const pageState = await checkPageState(frame, playDate);

    if (pageState === "ready") {
      const slots = await findAvailableSlots(frame, timeRange);
      if (slots.length > 0) {
        return { slots, updatedFrame: frame };
      }

      // For 30-day bookings, retry a few times in case of loading issues
      log(
        `No slots found in time range ${timeRange.start}-${timeRange.end} (attempt ${attempt}/${maxRetries}), retrying...`
      );
      await frame.waitForTimeout(1000);
      await frame.goto(frame.url());
      await frame.waitForLoadState("networkidle");
      attempt+= 2; // Skip next two attempts to avoid flooding the serve -- this is probably not recoverable
      continue;
    }

    if (pageState === "too-early") {
      log(
        `Tee times not yet available (attempt ${attempt}/${maxRetries}), waiting 0.3 seconds...`
      );
      await frame.waitForTimeout(300);
      await frame.goto(frame.url());
      await frame.waitForLoadState("networkidle");
      continue;
    }

    if (pageState === "no-results") {
      log(
        `Got "no times" message (attempt ${attempt}/${maxRetries}), waiting for page to fully load...`
      );
      await frame.waitForTimeout(500);
      continue;
    }

    if (pageState === "loading") {
      log(`Page still loading (attempt ${attempt}/${maxRetries}), waiting...`);
      await frame.waitForTimeout(500);
      continue;
    }
  }

  log(`Unable to find slots after ${maxRetries} attempts`);
  return { slots: [], updatedFrame: frame };
}

// Check API response for booking availability
async function checkApiForAvailability(
  timeRange: TimeRange,
  apiResponse: any
): Promise<"available" | "all-booked" | "not-released"> {
  const parseTime = (timeStr: string): number => {
    const [hour, minute] = timeStr.split(":").map(Number);
    return hour + minute / 60;
  };

  const startNum = parseTime(timeRange.start);
  const endNum = parseTime(timeRange.end);

  const timesInRange = apiResponse.data.teeSheet.filter((slot: any) => {
    if (!slot.teeTime) {
      log(`Skipping slot with no teeTime: ${JSON.stringify(slot)}`);
      return false;
    }

    const slotTime = parseTime(slot.teeTime);
    return slotTime >= startNum && slotTime <= endNum;
  });

  if (timesInRange.length === 0) {
    log(`🔍 API check: No times in range ${timeRange.start}-${timeRange.end} found in API response`);
    return "not-released";
  }

  const availableTimes = timesInRange.filter((slot: any) => slot.availPlayers === 4);
  if (availableTimes.length > 0) {
    log(`🟢 API check: Found ${availableTimes.length} available times in range`);
    return "available";
  }

  const allBooked = timesInRange.every((slot: any) => slot.availPlayers === 0);
  if (allBooked) {
    log(`🔴 API check: All times in range are fully booked (availPlayers: 0)`);
    return "all-booked";
  }

  log(`🟡 API check: Times exist but partial availability (not worth booking)`);
  return "all-booked"; // Treat partial availability as not worth continuing
}

type APIResult = "available" | "all-booked" | "not-released" | "timeout" 

// Navigate and capture API response during loading
async function navigateAndCaptureApiResponse(
  page: Page,
  playDate: string,
  timeRange: TimeRange
): Promise<{ 
  frame: Frame; 
  apiResult: APIResult
}> {
  let apiResult: APIResult = "timeout";
  const API_TIMEOUT_MS = 8000;
  
  // Set up API response capture BEFORE navigation
  const responsePromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, API_TIMEOUT_MS);

    const responseHandler = async (response: any) => {
      const url = response.url();
      if (url.includes('/api/v1/teetimes/GetAvailableTeeTimes/') && 
          url.includes(playDate.replace(/-/g, ''))) {
        try {
          const responseData = await response.json();
          apiResult = await checkApiForAvailability(timeRange, responseData);
        } catch (error) {
          log(`Failed to parse API response: ${error}`);
        } finally {
          clearTimeout(timeout);
          page.off('response', responseHandler);
          resolve();
        }
      }
    };

    page.on('response', responseHandler);
  });

  // Navigate to trigger the API call
  await navigateToBookingPage(page, playDate);
  const frame = await getBookingFrame(page);
  
  // Wait for both page load AND API response
  await Promise.all([
    waitForDateDataToLoad(frame),
    responsePromise
  ]);

  return { frame, apiResult };
}

// Find available slots with retry for 3-day bookings (full page refresh approach)
async function findAvailableSlots3Day(
  page: Page,
  timeRange: TimeRange,
  playDate: string,
  maxRetries = 30
): Promise<{ slots: Array<Slot>; updatedFrame: Frame | null }> {
  let currentFrame: Frame | null = null;
  let currentApiResult: APIResult = "timeout";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    
    const { apiResult, frame} = await navigateAndCaptureApiResponse(page, playDate, timeRange);
    currentFrame = frame;
    currentApiResult = apiResult;
    await waitForDateDataToLoad(currentFrame);
    
    if (currentApiResult === "all-booked" && attempt > 10) {
      log(`🛑 API confirms all times in range are booked - stopping retries`);
      return { slots: [], updatedFrame: currentFrame };
    } 
    
    if (currentApiResult === "available") {
      log(`🟢 API shows available times`);
    } 
    
    if (currentApiResult === "timeout") {
      log(`⏱️ API response timeout - continuing with DOM-based checks`);
    }
    
    const pageState = await checkPageState(currentFrame, playDate);

    if (pageState === "ready") {
      const slots = await findAvailableSlots(currentFrame, timeRange);
      if (slots.length > 0) {
        return { slots, updatedFrame: currentFrame };
      }

      // For 3-day bookings, retry more aggressively as slots may become available gradually
      const baseDelay = [1, 5, 10, 15, 30][Math.min(attempt, 4)] * 1000; // 1s, 5s, 10s, 15s, 30s
      const randomDelay = attempt > 4 ? Math.floor(Math.random() * 90000) : 0; // 0-90 seconds (1.5 minutes)
      const totalDelay = baseDelay + randomDelay;
      log(
        `No slots found in time range ${timeRange.start}-${
          timeRange.end
        } (attempt ${attempt}/${maxRetries}), retrying with full page refresh after ${Math.round(
          totalDelay / 1000
        )}s...`
      );
      await currentFrame.waitForTimeout(totalDelay);
      continue;
    }

    if (pageState === "too-early") {
      log(
        `Tee times not yet available (attempt ${attempt}/${maxRetries}), waiting with full page refresh...`
      );
      await currentFrame.waitForTimeout(1000);
    }

    if (pageState === "no-results") {
      log(
        `Got "no times" message (attempt ${attempt}/${maxRetries}), waiting for times to be released...`
      );
      await currentFrame.waitForTimeout(500);
      continue;
    }

    if (pageState === "loading") {
      log(`Page still loading (attempt ${attempt}/${maxRetries}), waiting...`);
      await currentFrame.waitForTimeout(500);
      continue;
    }
  }

  log(`Unable to find slots after ${maxRetries} attempts`);
  return { slots: [], updatedFrame: currentFrame };
}

// Find available slots
async function findAvailableSlots(
  frame: Frame,
  timeRange: TimeRange
): Promise<Slot[]> {
  // Wait for any loaders to disappear before scanning for slots
  try {
    await frame.waitForSelector('div.loader-wpr', { state: 'hidden', timeout: 3000 });
  } catch (e) {
    // Loader might not exist or already hidden, continue
  }
  
  // Give a brief moment for the page to stabilize after loader disappears
  await frame.waitForTimeout(300);
  
  return frame.evaluate(
    ({ start, end }) => {
      const parseTime = (timeStr: string): number => {
        const [hour, minute] = timeStr.split(":").map(Number);
        return hour + minute / 60;
      };

      const startNum = parseTime(start);
      const endNum = parseTime(end);
      const slots: Array<{ time: string; id: string }> = [];
      let slotIdCounter = 0;

      const rows = document.querySelectorAll(
        "div.flex-row.ng-scope:not(.unavailable)"
      );

      for (const row of rows) {
        const availDiv = row.querySelector(
          "div.availability.ng-scope strong.value.ng-binding"
        );
        if (!availDiv || availDiv.textContent?.trim() !== "4") continue;

        const timeDiv = row.querySelector(
          "div.teesheet-leftcol.ng-scope div.time.ng-binding"
        );
        if (!timeDiv) continue;

        const timeMatch = timeDiv.textContent?.match(
          /(\d{1,2}):(\d{2})\s*(AM|PM)/i
        );
        if (!timeMatch) continue;

        let hour = parseInt(timeMatch[1]);
        const minute = parseInt(timeMatch[2]);
        const isPM = timeMatch[3].toUpperCase() === "PM";

        if (isPM && hour !== 12) hour += 12;
        if (!isPM && hour === 12) hour = 0;

        const slotTime = hour + minute / 60;
        if (slotTime < startNum || slotTime > endNum) continue;

        const formattedTime = `${hour.toString().padStart(2, "0")}:${minute
          .toString()
          .padStart(2, "0")}`;

        // Set a unique ID on the element so we can find it later
        const uniqueId = `playwright-slot-${slotIdCounter++}`;
        if (timeDiv instanceof HTMLElement) {
          timeDiv.setAttribute("data-playwright-id", uniqueId);
        }

        slots.push({ time: formattedTime, id: uniqueId });
      }

      // Sort by time, prefer later times
      return slots.sort((a, b) => b.time.localeCompare(a.time));
    },
    { start: timeRange.start, end: timeRange.end }
  );
}

// Check if page shows tournament/maintenance using Gemini API
async function checkStateWithAI(
  page: Page,
  timeRange: TimeRange
): Promise<
  "AVAILABLE" | "EVENT" | "BOOKED" | "PENDING" | "MAINTENANCE" | "UNCLEAR"
> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    log("No Google AI API key found, skipping tournament check");
    return "UNCLEAR";
  }

  try {
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshot = screenshotBuffer.toString("base64");

    const requestData = JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Analyze this golf booking page for the time range ${timeRange.start} - ${timeRange.end}:

1. If there are tee times within this range showing "Available 4" (exactly 4 spots), respond: AVAILABLE
2. If there are tee times within this range but they show "Not Available" or "Available 1/2/3" (insufficient spots), respond: BOOKED  
3. If there are no tee times displayed within this range (but times exist before/after), respond: PENDING
4. If there are repeated identical entries, event names, or patterns indicating an organized event (tournament, league, etc.), respond: EVENT
5. If maintenance-related terms appear, respond: MAINTENANCE
6. If the page structure is unclear or doesn't fit above categories, respond: UNCLEAR

Look for these EVENT indicators:
- Repeated identical text across multiple time slots
- League names: "MENS LEAGUE", "WOMENS LEAGUE", "SENIOR LEAGUE", etc.
- Tournament/event names: "CANADA/LORA BAY DAY", "CLUB CHAMPIONSHIP", etc.
- Blocked time periods with consistent labeling
- Any text that appears identically across 3+ consecutive time slots

Answer with exactly one word: AVAILABLE, BOOKED, PENDING, EVENT, MAINTENANCE, or UNCLEAR`,
            },
            { inline_data: { mime_type: "image/png", data: screenshot } },
          ],
        },
      ],
    });

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "generativelanguage.googleapis.com",
          path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestData),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const response = JSON.parse(data);
              const text = response.candidates?.[0]?.content?.parts?.[0]?.text
                ?.trim()
                .toUpperCase();
              if (
                [
                  "AVAILABLE",
                  "EVENT",
                  "BOOKED",
                  "PENDING",
                  "MAINTENANCE",
                  "UNCLEAR",
                ].includes(text)
              ) {
                log(`🤖 AI detected: ${text}`);
                resolve(text as any);
              } else {
                log(`🤖 AI response unclear: ${text}`);
                resolve("UNCLEAR");
              }
            } catch (error) {
              log(`🤖 AI API error: ${error}`);
              resolve("UNCLEAR");
            }
          });
        }
      );

      req.on("error", (error) => {
        log(`🤖 AI request failed: ${error}`);
        resolve("UNCLEAR");
      });

      req.write(requestData);
      req.end();
    });
  } catch (error) {
    log(`🤖 AI check failed: ${error}`);
    return "UNCLEAR";
  }
}

// Book slot - returns 'success', 'locked', or 'error'
async function bookSlot(
  frame: Frame,
  slot: Slot
): Promise<"success" | "locked" | "error"> {
  try {
    // Wait for any loaders to disappear before clicking
    try {
      await frame.waitForSelector('div.loader-wpr', { state: 'hidden', timeout: 5000 });
    } catch (e) {
      // Loader might not exist or already hidden, continue
    }
        
    // Click the time slot - try normal click first, then force if needed
    try {
      await frame.click(`[data-playwright-id="${slot.id}"]`, { timeout: 10000 });
    } catch (error) {
      log(`Normal click failed for ${slot.time}, trying force click: ${error}`);
      await frame.click(`[data-playwright-id="${slot.id}"]`, { force: true, timeout: 5000 });
    }

    // Check for "Time Cannot be Locked" popup or booking form
    const result = await Promise.race([
      frame
        .waitForSelector("text=/Time Cannot be Locked/i", { timeout: 4000 })
        .then(() => "locked"),
      frame
        .waitForSelector('a.btn.btn-primary:has-text("BOOK NOW")', {
          timeout: 4000,
        })
        .then(() => "form"),
    ]).catch(() => "timeout");

    if (result === "locked") {
      log(`Time slot ${slot.time} is locked by another user`);
      // Close the locked modal before returning so it doesn't block subsequent clicks
      try {
        await frame.getByRole('button', { name: 'CLOSE' }).click({ timeout: 3000 });
        log(`Closed locked modal for ${slot.time}`);
      } catch (error) {
        log(`Failed to close locked modal for ${slot.time}: ${error}`);
      }
      return "locked";
    }

    if (result !== "form") {
      log(`Timeout waiting for booking form or lock message for ${slot.time}`);
      return "error";
    }

    // Complete booking
    await frame.getByText("ADD BUDDIES & GROUPS").click();
    await frame.getByText(/Test group \(\d+ people\)/i).click();

    // Click book now
    await frame.locator('a.btn.btn-primary:has-text("BOOK NOW")').click();
    log("Waiting for booking confirmation...");
    await frame.waitForLoadState("networkidle", { timeout: 5000 });
    await frame.waitForSelector("text=/Booking Confirmed/i", { timeout: 15000 });
    return "success";
  } catch (error) {
    log(`Booking failed: ${error}`);
    return "error";
  }
}

const confirmDateSelection = async (
  request: BookingRequest,
  frame: Frame,
  page: Page
) => {
  // Verify the date was pre-selected
  const [year, month, day] = request.playDate.split("-").map(Number);
  const playDate = new Date(year, month - 1, day);
  const targetDateText = `${playDate.toLocaleString("en-US", {
    month: "short",
  })} ${playDate.getDate()}`;

  const dateSelected = await frame.evaluate((expectedDate) => {
    const selectedEl = document.querySelector(
      "div.item.ng-scope.slick-slide.date-selected"
    );
    if (!selectedEl) return false;

    const dateDiv = selectedEl.querySelector("div.date.ng-binding");
    return dateDiv?.textContent?.includes(expectedDate) || false;
  }, targetDateText);

  if (!dateSelected) {
    log("Date not pre-selected, falling back to click method");
    if (takeScreenshots) {
      const screenshotPath = path.join(
        logDir,
        `date-selection-failure-${request.playDate}-${Date.now()}.png`
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    return await selectDateWithClick(frame, targetDateText);
  }

  log("Date successfully pre-selected via sessionStorage");
  return true;
};

// Wait for the page to fully load after date selection
async function waitForDateDataToLoad(
  frame: Frame,
  timeoutMs: number = 10000
): Promise<void> {
  log("Waiting for tee time data to load...");

  try {
    // Wait for one of several possible states that indicate the page has loaded
    await Promise.race([
      frame
        .waitForSelector(
          "div.flex-row.ng-scope:not(.unavailable) div.availability.ng-scope strong.value.ng-binding",
          { state: "visible", timeout: timeoutMs }
        )
        .then(() => {
          log("tee times have loaded successfully");
          return "success";
        }),

      frame
        .waitForSelector("text=/no.*tee.*times.*available/i", {
          state: "visible",
          timeout: timeoutMs,
        })
        .then(() => {
          log("No tee times available message found");
          return "no-times";
        }),

      frame
        .waitForSelector("text=/will become available/i", {
          state: "visible",
          timeout: timeoutMs,
        })
        .then(() => {
          log("Too early - tee times not yet released");
          return "too-early";
        }),
    ]);

    await frame.waitForTimeout(200);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Timed out waiting for page to load after ${timeoutMs}ms: ${errorMessage}`
    );
  }
}

// Shared booking attempt logic
async function attemptBooking(
  frame: Frame,
  slots: Slot[]
): Promise<{ bookedSlot: Slot | null; lastError: string }> {
  let bookedSlot: Slot | null = null;
  let lastError = "Unknown error";

  for (const slot of slots) {
    log(`Attempting to book ${slot.time}`);
    const result = await bookSlot(frame, slot);

    if (result === "success") {
      bookedSlot = slot;
      break;
    }

    if (result === "locked") {
      log(`Slot ${slot.time} locked, trying next slot...`);
      lastError = "Time slot locked by another user";
      continue;
    }

    log(`Error booking ${slot.time}, trying next slot...`);
    lastError = "Failed to complete booking";
    continue;
  }

  return { bookedSlot, lastError };
}

// Process a 30-day booking request (uses frame-based approach)
async function process30DayRequest(
  page: Page,
  request: BookingRequest,
  isFirstRequest: boolean
): Promise<{ message: string; success: boolean }> {
  try {
    if (!isFirstRequest) {
      await navigateToBookingPage(page, request.playDate);
    }

    const frame = await getBookingFrame(page);
    await waitForDateDataToLoad(frame);
    const dateSelected = await confirmDateSelection(request, frame, page);
    if (!dateSelected) {
      request.status = "failed";
      request.processedDate = new Date().toISOString();
      request.failureReason = "Could not select date";
      return {
        message: `❌ Request for ${request.playDate}: Failed to select date\n`,
        success: false,
      };
    }

    // For 30-day bookings, use frame-based retry logic to handle loading states
    const { slots, updatedFrame } = await findAvailableSlots30Day(
      frame,
      request.timeRange,
      request.playDate
    );
    if (slots.length === 0) {
      if (takeScreenshots) {
        const screenshotPath = path.join(
          logDir,
          `failure-30day-${request.playDate}-${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      request.status = "failed";
      request.processedDate = new Date().toISOString();
      request.failureReason = "No available times";
      return {
        message: `❌ Request for ${
          request.playDate
        }: No available times at ${getCurrentTimeET()}\n`,
        success: false,
      };
    }

    const { bookedSlot, lastError } = await attemptBooking(updatedFrame, slots);
    if (!bookedSlot) {
      request.status = "failed";
      request.processedDate = new Date().toISOString();
      request.failureReason = lastError;
      if (takeScreenshots) {
        const screenshotPath = path.join(
          logDir,
          `booking-failure-30day-${request.playDate}-${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      return {
        message: `❌ Request for ${
          request.playDate
        }: ${lastError} at ${getCurrentTimeET()}\n`,
        success: false,
      };
    }

    // Success
    request.status = "success";
    request.processedDate = new Date().toISOString();
    request.bookedTime = bookedSlot.time;

    if (takeScreenshots) {
      const screenshotPath = path.join(
        logDir,
        `success-30day-${request.playDate}-${Date.now()}.png`
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return {
      message: `✅ Request for ${request.playDate} booked for ${
        bookedSlot.time
      } at ${getCurrentTimeET()}\n`,
      success: true,
    };
  } catch (error) {
    request.status = "error";
    request.processedDate = new Date().toISOString();
    request.failureReason =
      error instanceof Error ? error.message : String(error);
    return {
      message: `⚠️ Request ${request.id}: Error - ${request.failureReason}\n`,
      success: false,
    };
  }
}

// Process a 3-day booking request (uses full page refresh approach)
async function process3DayRequest(
  page: Page,
  request: BookingRequest
): Promise<{ message: string; success: boolean }> {
  try {
    // For 3-day bookings, use aggressive retry logic with full page refreshes
    const { slots, updatedFrame } = await findAvailableSlots3Day(
      page,
      request.timeRange,
      request.playDate
    );
    if (slots.length === 0 || updatedFrame === null) {
      if (takeScreenshots) {
        const screenshotPath = path.join(
          logDir,
          `failure-3day-${request.playDate}-${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      request.status = "failed";
      request.processedDate = new Date().toISOString();
      request.failureReason = "No available times";
      return {
        message: `❌ Request for ${
          request.playDate
        }: No available times at ${getCurrentTimeET()}\n`,
        success: false,
      };
    }

    const { bookedSlot, lastError } = await attemptBooking(updatedFrame, slots);

    if (!bookedSlot) {
      request.status = "failed";
      request.processedDate = new Date().toISOString();
      request.failureReason = lastError;
      if (takeScreenshots) {
        const screenshotPath = path.join(
          logDir,
          `booking-failure-3day-${request.playDate}-${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      return {
        message: `❌ Request for ${
          request.playDate
        }: ${lastError} at ${getCurrentTimeET()}\n`,
        success: false,
      };
    }

    // Success
    request.status = "success";
    request.processedDate = new Date().toISOString();
    request.bookedTime = bookedSlot.time;

    if (takeScreenshots) {
      const screenshotPath = path.join(
        logDir,
        `success-3day-${request.playDate}-${Date.now()}.png`
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return {
      message: `✅ Request for ${request.playDate} booked for ${
        bookedSlot.time
      } at ${getCurrentTimeET()}\n`,
      success: true,
    };
  } catch (error) {
    request.status = "error";
    request.processedDate = new Date().toISOString();
    request.failureReason =
      error instanceof Error ? error.message : String(error);
    return {
      message: `⚠️ Request ${request.id}: Error - ${request.failureReason}\n`,
      success: false,
    };
  }
}

// Main request processor that delegates to appropriate handler
async function processRequest(
  page: Page,
  request: BookingRequest,
  isFirstRequest: boolean
): Promise<{ message: string; success: boolean }> {
  const is3DayBooking = !isFirstRequest; //isWithinThreeDaysBooking(request.playDate);

  if (is3DayBooking) {
    log(
      `Processing 3-day booking for ${request.playDate} (requires full page refresh)`
    );
    return await process3DayRequest(page, request);
  }

  log(
    `Processing 30-day booking for ${request.playDate} (frame-based approach)`
  );
  return await process30DayRequest(page, request, isFirstRequest);
}

// Main entry point
async function main(): Promise<void> {
  log("Starting booking queue processing");

  const queueData = await initializeQueue();
  const todayRequests = filterTodayRequests(queueData);

  if (todayRequests.length === 0) {
    log("No booking requests for today");
    setOutput("processed_count", "0");
    setOutput("booking_status", "success");
    setOutput("results", "No booking requests for today.");
    return;
  }

  log(`Found ${todayRequests.length} requests for today`);

  // Log the order we'll process them
  if (todayRequests.length > 0) {
    log("Processing order (furthest dates first for maximum competitiveness):");
    todayRequests.forEach((req) => {
      const bookingType = isWithinThreeDaysBooking(req.playDate)
        ? "3-day"
        : "30-day";
      log(
        `  - ${req.playDate} (${req.timeRange.start}-${req.timeRange.end}) [${bookingType}]`
      );
    });
  }

  let browser: Browser | null = null;
  let results = "";
  let processedCount = 0;

  try {
    // Create browser and page once
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      timezoneId: "America/Toronto",
      locale: "en-CA",
    });
    const page = await context.newPage();

    // Perform initial login with first request
    await setDateInSessionStorage(page, todayRequests[0].playDate);
    await performInitialLogin(page);

    // Wait until 7:00 AM ET if scheduled run (do this AFTER login to maximize session time)
    if (process.env.IS_SCHEDULED_RUN === "true") {
      const nowInET = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
      );
      let nextHour = nowInET.getHours() + 1;
      if (nextHour === 24) {
        // Handle midnight case
        nextHour = 0;
      }
      log(`Sleeping until ${nextHour}:00 ET`);
      await sleepUntilTimeInZone(nextHour, 0);
    }

    // Process all requests using the same browser session
    for (let i = 0; i < todayRequests.length; i++) {
      const request = todayRequests[i];
      const isFirstRequest = i === 0;
      const is3DayBooking = isWithinThreeDaysBooking(request.playDate);

      log(
        `Processing request ${i + 1}/${todayRequests.length}: ${
          request.playDate
        } (${is3DayBooking ? "3-day" : "30-day"} booking)`
      );

      const result = await processRequest(page, request, isFirstRequest);
      results += result.message;
      if (result.success) processedCount++;
    }
  } finally {
    if (browser) await browser.close();
  }

  // Update queue
  queueData.bookingRequests = queueData.bookingRequests.filter(
    (r) => r.status === "pending"
  );
  queueData.processedRequests = [
    ...todayRequests,
    ...queueData.processedRequests,
  ];
  fs.writeFileSync(queueFilePath, JSON.stringify(queueData, null, 2));

  // Set outputs
  log(`Processed ${processedCount} requests`);
  setOutput("processed_count", processedCount.toString());
  setOutput("booking_status", processedCount > 0 ? "success" : "failure");
  setOutput("results", results);

  logStream.end();
}

// Run the processor
main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  log(`FATAL ERROR: ${errorMessage}`);
  log(error instanceof Error ? error.stack || "" : "");
  logStream.end();
  process.exit(1);
});
