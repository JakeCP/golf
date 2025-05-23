import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page, Browser, Frame } from '@playwright/test';
import { WriteStream } from 'fs';
import * as dotenv from 'dotenv';

// Load environment variables from .env file for local testing
dotenv.config();

// Define types for our queue data
interface TimeRange {
  start: string;
  end: string;
}

interface BookingRequest {
  id: string;
  requestDate: string;
  playDate: string;
  timeRange: TimeRange;
  status: 'pending' | 'success' | 'failed' | 'error';
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

interface AvailableTime {
  time: string;
  id: string;
}

// Local testing flags
const isTestMode = process.env.TEST_MODE === 'true';
const simulateBooking = process.env.SIMULATE_BOOKING === 'true';
const takeScreenshots = process.env.TAKE_SCREENSHOTS !== 'false'; // Default to true unless explicitly disabled
const headless = process.env.HEADLESS !== 'false'; // Default to true unless explicitly disabled

const setOutput = (name: string, value: string) => {
  const dest = process.env.GITHUB_OUTPUT;
  if (dest) {
    fs.appendFileSync(dest, `${name}<<EOF\n${value}\nEOF\n`);
  } else {
    console.log(`${name}=${value}`);         // still useful when you run locally
  }
};

// Helper function to get today's date with optional override from environment variable
const getTodayDate = (): string => {
  if (process.env.DATE_OVERRIDE) {
    // Format should be YYYY-MM-DD
    const dateOverride = process.env.DATE_OVERRIDE;
    log(`Using date override: ${dateOverride}`);
    return dateOverride;
  }
  // Get date in EST
  const estDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const dateObj = new Date(estDate);
  const year = dateObj.getFullYear();
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const day = dateObj.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Setup logging
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logFilePath = path.join(logDir, `processing-${new Date().toISOString().replace(/:/g, '-')}.log`);
const logStream: WriteStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const log = (message: string): void => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  logStream.write(logMessage + '\n');
};

// Get queue file path (adjust for testing)
const getQueueFilePath = (): string => {
  return isTestMode 
    ? path.join(__dirname, 'test-booking-queue.json')
    : path.join(__dirname, 'booking-queue.json');
};

// Create mock data for testing
const createTestData = (): void => {
  const queuePath = getQueueFilePath();
  
  if (isTestMode && !fs.existsSync(queuePath)) {
    log('Creating test queue data');
    
    // Create a test request for today
    const today = getTodayDate();
    const testQueue: QueueData = {
      bookingRequests: [
        {
          id: `test-${Date.now()}`,
          requestDate: new Date().toISOString(),
          playDate: today,
          timeRange: {
            start: "08:00",
            end: "12:00",
          },
          status: 'pending',
          requestedBy: 'test-user'
        }
      ],
      processedRequests: []
    };
    
    fs.writeFileSync(queuePath, JSON.stringify(testQueue, null, 2));
    log(`Created test queue file at ${queuePath}`);
  }
};

// Mock the browser interactions for testing
const mockBrowserActions = async (): Promise<void> => {
  log('SIMULATION MODE: Mocking browser interactions');
  
  // Simulate a 2-second delay for "browser startup"
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Simulate login
  log('SIMULATION: Logged in successfully');
  
  // Simulate booking page navigation
  log('SIMULATION: Navigated to booking page');
  
  // Simulate finding available times
  const mockAvailableTimes: AvailableTime[] = [
    { time: '09:30', id: 'mock-time-1' },
    { time: '10:15', id: 'mock-time-2' },
    { time: '11:00', id: 'mock-time-3' }
  ];
  
  log(`SIMULATION: Found ${mockAvailableTimes.length} available times`);
  return;
};

const logEmptyBooking = (queuePath: string): void => {
  log(`No booking queue file found at ${queuePath}. Creating empty queue.`);
  const emptyQueue: QueueData = {
    bookingRequests: [],
    processedRequests: []
  };
  fs.writeFileSync(queuePath, JSON.stringify(emptyQueue, null, 2));
  setOutput('processed_count', "0");
  setOutput('booking_status', 'failure');
  setOutput('results', 'No booking requests in queue.');
  console.log('processed_count=0' + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
  console.log('results=No booking requests in queue.' + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
  return;
}

async function initializeQueue(): Promise<QueueData> {
  const queuePath = getQueueFilePath();

  if (!fs.existsSync(queuePath)) {
    logEmptyBooking(queuePath);
    return { bookingRequests: [], processedRequests: [] };
  }

  return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
}

function filterTodayRequests(queueData: QueueData): BookingRequest[] {
  const today = getTodayDate(); // today is a 'YYYY-MM-DD' string

  // Date string for exactly 30 days from 'today'
  const thirtyDaysFromToday_DateObj = new Date(today);
  thirtyDaysFromToday_DateObj.setDate(thirtyDaysFromToday_DateObj.getDate() + 30);
  const thirtyDaysFromTodayString = thirtyDaysFromToday_DateObj.toISOString().split('T')[0];

  // Date strings for 3 days before and 3 days after 'today'
  const todayDateObjForRange = new Date(today);


  const datePlus3 = new Date(todayDateObjForRange);
  datePlus3.setDate(todayDateObjForRange.getDate() + 3);
  const threeDaysAfterTodayString = datePlus3.toISOString().split('T')[0];

  return queueData.bookingRequests.filter(request => {
    if (request.status !== 'pending') {
      return false;
    }
    // Condition 1: playDate is exactly 30 days from 'today'
    const isExactly30Days = request.playDate === thirtyDaysFromTodayString;

    // Condition 2: playDate is within 3 days of 'today' (inclusive)
    const isWithin3DaysOfToday = request.playDate >= today && request.playDate <= threeDaysAfterTodayString;

    return isExactly30Days || isWithin3DaysOfToday;
  });
}

async function simulateProcessingRequests(
  todayRequests: BookingRequest[],
  queueData: QueueData,
  queuePath: string
): Promise<{ results: string; processedCount: number }> {
  await mockBrowserActions();
  let results = '';
  let processedCount = 0;
  const maxConcurrentRequests = 3; // Matching the real processing

  // Simulate the delay effect of multiple parallel processes
  const processRequestInParallel = async (request: BookingRequest): Promise<string> => {
    log(`SIMULATION: Processing request ${request.id} for ${request.playDate}`);
    
    // Simulate processing time (variable to mimic real world)
    const processingTime = 500 + Math.floor(Math.random() * 1000);
    await new Promise(resolve => setTimeout(resolve, processingTime));
    
    request.status = 'success';
    request.processedDate = new Date().toISOString();
    request.bookedTime = '09:30';
    request.confirmationNumber = `SIM-${Math.floor(100000 + Math.random() * 900000)}`;
    
    log(`SIMULATION: Successfully booked tee time at ${request.bookedTime}`);
    log(`SIMULATION: Confirmation number: ${request.confirmationNumber}`);
    
    return `✅ Request ${request.id}: Booked for ${request.bookedTime} (Confirmation: ${request.confirmationNumber})\n`;
  };

  // Process requests in batches for better control
  log(`Simulating ${todayRequests.length} requests in batches of ${maxConcurrentRequests}`);
  
  // Create batches of requests
  const requestBatches = [];
  for (let i = 0; i < todayRequests.length; i += maxConcurrentRequests) {
    requestBatches.push(todayRequests.slice(i, i + maxConcurrentRequests));
  }
  
  // Process each batch in parallel
  for (let batchIndex = 0; batchIndex < requestBatches.length; batchIndex++) {
    const batch = requestBatches[batchIndex];
    log(`Simulating batch ${batchIndex + 1} of ${requestBatches.length} with ${batch.length} requests`);
    
    const batchResults = await Promise.all(
      batch.map(request => processRequestInParallel(request))
    );
    
    // Collect results from the batch
    results += batchResults.join('');
    processedCount += batchResults.length; // Count all successful simulations
  }

  queueData.bookingRequests = queueData.bookingRequests.filter(request =>
    !(request.playDate === getTodayDate() && request.status !== 'pending')
  );
  queueData.processedRequests = [...todayRequests, ...queueData.processedRequests];
  fs.writeFileSync(queuePath, JSON.stringify(queueData, null, 2));
  return { results, processedCount };
}

const navigateToBookingPage = async (page: Page): Promise<void> => {
  log('Navigating to booking page');
  await page.goto('https://lorabaygolf.clubhouseonline-e3.com/TeeTimes/TeeSheet.aspx');
}

/**
 * Waits/sleeps until a specified time in a given IANA timezone.
 *
 * @param {number} targetHour24 The target hour in 24-hour format (0-23).
 * @param {number} targetMinute The target minute (0-59).
 * @param {string} timeZoneIANA The IANA timezone name (e.g., 'America/New_York', 'Europe/London').
 * @returns {Promise<void>} A Promise that resolves when the target time is reached.
 * Rejects if the timezone is invalid or delay calculation fails.
 */
const sleepUntilTimeInZone = async (targetHour24: number, targetMinute: number, timeZoneIANA = 'America/New_York'): Promise<void> => {
    return new Promise((resolve, reject) => {
        const calculateDelay = () => {
            try {
                const now = new Date(); // Current moment in time (internally UTC)

                // Get the current offset of the target timezone from GMT/UTC.
                // We use Intl.DateTimeFormat with 'longOffset' which gives strings like "GMT-04:00".
                // This offset is based on 'now' (the time of calculation).
                const offsetFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: timeZoneIANA,
                    timeZoneName: 'longOffset',
                });
                // We need to format a date to get the parts, including the timeZoneName part.
                const offsetParts = offsetFormatter.formatToParts(now);
                const offsetStringPart = offsetParts.find(part => part.type === 'timeZoneName');

                if (!offsetStringPart) {
                    throw new Error(`Could not determine timezone offset for '${timeZoneIANA}'. Check if the timezone name is valid.`);
                }
                const offsetString = offsetStringPart.value; // e.g., "GMT-4", "GMT-04:00", "GMT+5:30"

                const offsetMatch = offsetString.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
                if (!offsetMatch) {
                    throw new Error(`Could not parse offset string: '${offsetString}' for timezone '${timeZoneIANA}'.`);
                }

                const offsetSign = offsetMatch[1] === '+' ? 1 : -1;
                const offsetHours = parseInt(offsetMatch[2], 10);
                const offsetRuleMinutes = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;
                // totalOffsetMinutes is the offset of the target zone from GMT, in minutes.
                // e.g., GMT-4 -> -240 minutes. GMT+5:30 -> 330 minutes.
                const totalOffsetMinutes = offsetSign * (offsetHours * 60 + offsetRuleMinutes);

                // Get current year, month, day IN THE TARGET TIMEZONE.
                // This establishes the "current day" context for the target time.
                const ymdFormatter = new Intl.DateTimeFormat('en-CA', { // Using 'en-CA' for YYYY-MM-DD like parts
                    timeZone: timeZoneIANA,
                    year: 'numeric',
                    month: '2-digit', // Use 2-digit to simplify parsing if needed, though direct numeric is fine
                    day: '2-digit',
                });
                const currentDatePartsInZone = ymdFormatter.formatToParts(now).reduce<{[key: string]: number}>((acc, part) => {
                    if (part.type !== 'literal' && part.type !== 'timeZoneName') { // Exclude literals and timeZoneName if present
                        acc[part.type] = parseInt(part.value, 10);
                    }
                    return acc;
                }, {});


                // Construct the target Date object in UTC.
                // Start with Date.UTC(year, monthIndex, day, hour, minute) using the zone's current date
                // and the target hour/minute. This timestamp is initially as if targetHour24/targetMinute were UTC.
                let targetDateAttempt = new Date(Date.UTC(
                    currentDatePartsInZone.year,
                    currentDatePartsInZone.month - 1, // month for Date.UTC is 0-indexed
                    currentDatePartsInZone.day,
                    targetHour24,
                    targetMinute,
                    0, 0 // seconds, milliseconds
                ));

                // Adjust this UTC time by the zone's offset to get the true UTC equivalent of the wall clock time.
                // If wall time is 7 AM in GMT-4, its UTC equivalent is 7 AM - (-4 hours) = 11 AM UTC.
                // So, we subtract the zone's offset from the UTC time we constructed.
                targetDateAttempt.setUTCMinutes(targetDateAttempt.getUTCMinutes() - totalOffsetMinutes);

                // Check if this calculated target time (in UTC) has already passed compared to 'now' (in UTC).
                if (targetDateAttempt.getTime() <= now.getTime()) {
                    // The target time for "today" (in the specified zone) has passed or is now.
                    // We need to aim for the target time on "tomorrow" (in the specified zone).

                    // Create a date object representing roughly 24 hours from the initial target attempt.
                    // This helps ensure we are on the next calendar day in the target zone.
                    let nextDayCandidate = new Date(targetDateAttempt.getTime());
                    nextDayCandidate.setUTCDate(nextDayCandidate.getUTCDate() + 1);

                    // Get the year, month, day for this nextDayCandidate IN THE TARGET TIMEZONE.
                    const nextDatePartsInZone = ymdFormatter.formatToParts(nextDayCandidate).reduce<{[key: string]: number}>((acc, part) => {
                        if (part.type !== 'literal' && part.type !== 'timeZoneName') {
                             acc[part.type] = parseInt(part.value, 10);
                        }
                        return acc;
                    }, {});

                    // Reconstruct the targetDateAttempt for this "next day" in the zone.
                    targetDateAttempt = new Date(Date.UTC(
                        nextDatePartsInZone.year,
                        nextDatePartsInZone.month - 1, // month for Date.UTC is 0-indexed
                        nextDatePartsInZone.day,
                        targetHour24,
                        targetMinute,
                        0, 0
                    ));
                    // Re-apply the offset adjustment. The offset itself is assumed to be relatively stable
                    // for "today" vs "tomorrow" for this calculation's purpose, though this is where
                    // DST changes far in the future could introduce slight inaccuracies if not re-evaluated.
                    targetDateAttempt.setUTCMinutes(targetDateAttempt.getUTCMinutes() - totalOffsetMinutes);
                }

                const msUntilTarget = targetDateAttempt.getTime() - now.getTime();
                return msUntilTarget > 0 ? msUntilTarget : 0; // Ensure non-negative delay

            } catch (error) {
                console.error("Error in calculateDelay:", error);
                reject(error); // Propagate error to the promise
                return null; // Indicate failure
            }
        };

        const delay = calculateDelay();

        if (delay === null) {
            // Error already handled by rejecting the promise in calculateDelay
            return;
        }

        if (delay <= 0) {
            console.log(`Target time ${String(targetHour24).padStart(2,'0')}:${String(targetMinute).padStart(2,'0')} in ${timeZoneIANA} is in the past or now. Resolving immediately.`);
            resolve();
            return;
        }

        const targetActualDate = new Date(Date.now() + delay);
        console.log(`Waiting for ${delay}ms (until approximately ${targetActualDate.toLocaleString('en-US', { timeZone: timeZoneIANA, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} in ${timeZoneIANA})`);
        setTimeout(() => {
            console.log(`Reached target time: ${String(targetHour24).padStart(2,'0')}:${String(targetMinute).padStart(2,'0')} in ${timeZoneIANA}`);
            resolve();
        }, delay);
    });
}

async function processRealRequests(
  todayRequests: BookingRequest[],
  queueData: QueueData,
  queuePath: string
): Promise<{ results: string; processedCount: number }> {
  let results = '';
  let processedCount = 0;
  const maxRetries = 3;
  const retryDelay = 30000; // 30 seconds
  const maxConcurrentRequests = 3; // Maximum number of concurrent browser instances

  try {
    const processRequestWithNewBrowser = async (request: BookingRequest): Promise<{ 
      message: string; 
      success: boolean;
      request: BookingRequest;
    }> => {
      let browser: Browser | null = null;
      let attempt = 0;
      let requestProcessedSuccessfully = false;
      let requestResultMessage = '';

      try {
        browser = await chromium.launch({ headless: headless });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        await loginToWebsite(page);

        // Wait until 7:00 AM ET after login but before processing requests
        if (process.env.IS_SCHEDULED_RUN && attempt === 1) {
          log('Waiting until 7:00 AM ET before processing requests');
          try {
            await sleepUntilTimeInZone(7, 0, 'America/New_York');
            log('Target time reached - starting request processing');
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(`Error during sleep: ${errorMessage}. Proceeding with processing.`);
          }
        }

        while (attempt < maxRetries && !requestProcessedSuccessfully) {
          attempt++;
          if (attempt > 1) {
            log(`Retrying request ${request.id}, attempt ${attempt} of ${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
          
          await navigateToBookingPage(page);
          const bookingFrame = await getBookingFrame(page);
          await waitForGolfCourseElement(bookingFrame);
          await bookingFrame.waitForLoadState('networkidle');
          
          const result = await processSingleRequest(page, bookingFrame, request);
          requestResultMessage = result.message;
          requestProcessedSuccessfully = result.success;

          if (requestProcessedSuccessfully) {
            log(`Request ${request.id} processed successfully on attempt ${attempt}.`);
            break; 
          } else {
            log(`Request ${request.id} failed on attempt ${attempt}. Reason: ${request.failureReason}`);
            if (attempt === maxRetries) {
              log(`Request ${request.id} failed after ${maxRetries} attempts.`);
            }
          }
        }
        
        return { 
          message: requestResultMessage, 
          success: requestProcessedSuccessfully,
          request: request
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error processing request ${request.id}: ${errorMessage}`);
        request.status = 'error';
        request.processedDate = new Date().toISOString();
        request.failureReason = errorMessage;
        return { 
          message: `⚠️ Request ${request.id}: Error - ${errorMessage}\n`, 
          success: false,
          request: request 
        };
      } finally {
        if (browser) await browser.close();
      }
    };

    log(`Processing ${todayRequests.length} requests in batches of ${maxConcurrentRequests}`);
    
    for (let i = 0; i < todayRequests.length; i += maxConcurrentRequests) {
      const batch = todayRequests.slice(i, i + maxConcurrentRequests);
      log(`Processing batch ${Math.floor(i / maxConcurrentRequests) + 1} with ${batch.length} requests`);
      
      const batchResults = await Promise.all(
        batch.map(request => processRequestWithNewBrowser(request))
      );
      
      for (const result of batchResults) {
        results += result.message;
        if (result.success) {
          processedCount++;
        }
      }
    }
  } catch (error) {
    log(`Fatal error in parallel processing: ${error instanceof Error ? error.message : String(error)}`);
  }

  queueData.bookingRequests = queueData.bookingRequests.filter(request => request.status === 'pending');
  queueData.processedRequests = [...todayRequests, ...queueData.processedRequests];
  fs.writeFileSync(queuePath, JSON.stringify(queueData, null, 2));
  return { results, processedCount };
}

async function loginToWebsite(page: Page): Promise<void> {
  log('Logging in to golf course website');
  await page.goto('https://lorabaygolf.clubhouseonline-e3.com/login.aspx');
  const username = process.env.GOLF_USERNAME;
  const password = process.env.GOLF_PASSWORD;

  if (!username || !password) {
    throw new Error('Golf course credentials not found in environment variables');
  }

  await page.getByPlaceholder('Username').fill(username);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
}

async function findAvailableTeeSlotsInFrame(
  bookingFrame: Frame,
  timeRange: TimeRange
): Promise<Array<{ time: string; id: string; sortableTime: string }>> {
  return bookingFrame.evaluate(({ timeRangeStart, timeRangeEnd }) => {
    const slots: Array<{ time: string; id: string; sortableTime: string }> = [];
    let slotIdCounter = 0;

    const parseTime = (timeStrWithAmPm: string): { hour: number; minute: number; formattedTime: string } | null => {
      const timeMatch = timeStrWithAmPm.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!timeMatch) return null;
      let hour = parseInt(timeMatch[1], 10);
      const minute = parseInt(timeMatch[2], 10);
      const ampm = timeMatch[3].toUpperCase();
      if (ampm === 'PM' && hour !== 12) {
        hour += 12;
      } else if (ampm === 'AM' && hour === 12) {
        hour = 0;
      }
      return { hour, minute, formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
    };

    // Helper to convert "HH:MM" string to a comparable number (e.g., "09:30" -> 9.5)
    const timeStringToNumber = (timeStr: string): number => {
      const [hour, minute] = timeStr.split(':').map(Number);
      return hour + minute / 60;
    };

    const startHourNum = timeStringToNumber(timeRangeStart);
    const endHourNum = timeStringToNumber(timeRangeEnd);

    const flexRows = document.querySelectorAll('div.flex-row.ng-scope');
    flexRows.forEach(row => {
      if (row.classList.contains('unavailable')) return;
      const availabilityDiv = row.querySelector('div.availability.ng-scope');
      if (!availabilityDiv) return;
      const valueStrong = availabilityDiv.querySelector('strong.value.ng-binding');
      if (!valueStrong || !valueStrong.textContent || parseInt(valueStrong.textContent.trim(), 10) !== 4) return;
      const timeDiv = row.querySelector('div.teesheet-leftcol.ng-scope div.time.ng-binding');
      if (!timeDiv || !timeDiv.textContent) return;
      const timeStrMatch = timeDiv.textContent.trim().match(/(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
      if (!timeStrMatch || !timeStrMatch[1]) return;
      const parsed = parseTime(timeStrMatch[1]);
      // Compare based on the numeric representation of the 24-hour time
      if (!parsed) return;
      const slotTimeNum = parsed.hour + parsed.minute / 60;
      if (slotTimeNum < startHourNum || slotTimeNum > endHourNum) return;
      const uniqueId = `playwright-slot-${slotIdCounter++}`;
      if (timeDiv instanceof HTMLElement) timeDiv.setAttribute('data-playwright-id', uniqueId);
      slots.push({ time: parsed.formattedTime, id: uniqueId, sortableTime: parsed.formattedTime });
    });
    return slots;
  }, { timeRangeStart: timeRange.start, timeRangeEnd: timeRange.end });
  
}

const clickOnDateInFrame = async (bookingFrame: Frame, targetDateText: string): Promise<boolean> => {
  return bookingFrame.evaluate((dateText: string) => {
    const dateElements = document.querySelectorAll('div.item.ng-scope.slick-slide');
    for (const el of dateElements) {
      const dateDiv = el.querySelector('div.date.ng-binding');
      if (dateDiv && dateDiv.textContent && dateDiv.textContent.trim().includes(dateText)) {
        if (el instanceof HTMLElement) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, targetDateText);
};

/**
 * Wait for the selected date element to appear, indicating the date's data has loaded
 */
const waitForSelectedDateElement = async (bookingFrame: Frame, targetDateText: string, timeoutMs: number = 10000): Promise<void> => {
  log(`Waiting for selected date element "${targetDateText}" to appear`);
  try {
    // Selector for the parent div with 'date-selected' class
    // and a child div.date.ng-binding that contains the targetDateText
    const selector = `div.item.ng-scope.slick-slide.date-selected:has(div.date.ng-binding:text-is("${targetDateText}"))`;
    await bookingFrame.waitForSelector(
      selector,
      { state: 'visible', timeout: timeoutMs }
    );
    log(`Selected date element "${targetDateText}" found, continuing with booking`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`ERROR: Timed out waiting for selected date element "${targetDateText}": ${errorMessage}`);
    throw new Error(`Failed to load tee times: Selected date element "${targetDateText}" not found after ${timeoutMs}ms`);
  }
};

/**
 * Wait for the Golf Course element to appear, indicating the date's data has loaded
 */
const waitForGolfCourseElement = async (bookingFrame: Frame, timeoutMs: number = 10000): Promise<void> => {
  log('Waiting for Golf Course element to appear after date selection');
  try {
    await bookingFrame.waitForSelector(
      'div.input-wpr:has(label:text-is("Golf Course")) div.input:text-is("Lora Bay")', 
      { state: 'visible', timeout: timeoutMs }
    );
    log('Golf Course element found, continuing with booking');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`ERROR: Timed out waiting for Golf Course element: ${errorMessage}`);
    throw new Error(`Failed to load tee times: Golf Course element not found after ${timeoutMs}ms`);
  }
};


const getBookingFrame = async (page: Page): Promise<Frame> => {
  const iframeHandle = await page.locator('iframe#module').elementHandle();
  if (!iframeHandle) throw new Error('Booking iframe not found');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Unable to resolve content frame');
  return frame;
};


const getScreenshotName = (action: string, requestId?: string): string => {
      return requestId 
      ? `${action}-${requestId}-${new Date().toISOString().replace(/:/g, '-')}.png`
      : `${action}-${new Date().toISOString().replace(/:/g, '-')}.png`;
}

const screenshotWebsiteState = async (page: Page, screenshotName: string): Promise<void> => {
  if (page.isClosed?.()) {
    log(`WARNING: Cannot take screenshot "${screenshotName}" - page is already closed`);
    return;
  }

  if (takeScreenshots) {
    log('Taking screenshot of the current website state');
    try {
      const logsDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const screenshotPath = path.join(logsDir, screenshotName);
      await page.screenshot({ path: screenshotPath, timeout: 5000, fullPage: true });
      log(`Screenshot saved to ${screenshotPath}`);
    } catch (error) {
      log(`WARNING: Failed to take screenshot "${screenshotName}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  log('Screenshotting is disabled, skipping screenshot');
};

const confirmBookingInFrame = async (bookingFrame: Frame, page: Page, requestId?: string): Promise<void> => {
  log('Confirming booking inside iframe');
  await bookingFrame.getByText('ADD BUDDIES & GROUPS').click();
  await bookingFrame.getByText(/Test group \(\d+ people\)/i).click();
  // Click the book now button
  //await bookingFrame.locator('a.btn.btn-primary:has-text("BOOK NOW")').click();
  await bookingFrame.waitForLoadState('networkidle');
  await bookingFrame.waitForTimeout(3000); // Wait for 3 seconds to allow data to load
  // Take a screenshot after booking to verify success (if enabled)
  if (takeScreenshots) {
    log('Taking confirmation screenshot');
    await screenshotWebsiteState(page, getScreenshotName("booking-confirmation", requestId));
    return;
  } 
};

async function processSingleRequest(
  page: Page,
  bookingFrame: Frame,
  request: BookingRequest
): Promise<{ message: string; success: boolean }> {
  try {
    log(`Processing request ${request.id} for ${request.playDate}`);
    // Build target date string e.g. "Jul 12"
    const [yearStr, monthStr, dayStr] = request.playDate.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr) - 1;
    const day = Number(dayStr);
    const playDateObj = new Date(year, month, day);
    if (isNaN(playDateObj.getTime())) {
      await screenshotWebsiteState(page, getScreenshotName("invalid-date-request", request.id));
      request.status = 'error';
      request.processedDate = new Date().toISOString();
      request.failureReason = `Invalid date in request: ${request.playDate}`;
      log(`ERROR: Invalid date in request ${request.id}: ${request.playDate}`);
      return { message: `⚠️ Request ${request.id}: Invalid date ${request.playDate}\n`, success: false };
    }
    const targetDateText = `${playDateObj.toLocaleString('en-US', { month: 'short' })} ${playDateObj.getDate()}`;
    log(`Attempting to select date: "${targetDateText}"`);
    await bookingFrame.waitForLoadState('networkidle');
    const dateClicked = await clickOnDateInFrame(bookingFrame, targetDateText);
    if (!dateClicked) {
      await screenshotWebsiteState(page, getScreenshotName("failed-to-select-date", request.id));
      request.status = 'failed';
      request.processedDate = new Date().toISOString();
      request.failureReason = `Could not select date "${targetDateText}"`;
      log(`ERROR: Could not click date element for "${targetDateText}"`);
      return { message: `❌ Request ${request.id}: Failed to select date "${targetDateText}"\n`, success: false };
    }

    log(`Successfully clicked date "${targetDateText}"`);
    
    // Wait for the selected date element to appear, indicating the date's data has loaded
    await waitForSelectedDateElement(bookingFrame, targetDateText);
    await bookingFrame.waitForTimeout(3000); // Wait for 3 seconds to allow data to load
    await bookingFrame.waitForLoadState('networkidle');

    const availableTimes = await findAvailableTeeSlotsInFrame(bookingFrame, request.timeRange);
    if (availableTimes.length === 0) {
      await screenshotWebsiteState(page, getScreenshotName("no-available-time", request.id));
      request.status = 'failed';
      request.processedDate = new Date().toISOString();
      request.failureReason = 'No times with 4 spots in range';
      log(`INFO: No tee times found for request ${request.id}`);
      return { message: `❌ Request ${request.id}: No available times\n`, success: false };
    }

    availableTimes.sort((a, b) => a.sortableTime.localeCompare(b.sortableTime)).reverse();
    const selectedSlot = availableTimes[0];
    log(`Attempting to book time ${selectedSlot.time} using id ${selectedSlot.id}`);

    await bookingFrame.click(`[data-playwright-id="${selectedSlot.id}"]`);
    await confirmBookingInFrame(bookingFrame, page, request.id);

    request.status = 'success';
    request.processedDate = new Date().toISOString();
    request.bookedTime = selectedSlot.time;

    return { message: `✅ Request ${request.id}: Booked for ${selectedSlot.time}\n`, success: true };
  } catch (error) {
    request.status = 'error';
    request.processedDate = new Date().toISOString();
    request.failureReason = error instanceof Error ? error.message : String(error);
    return { message: `⚠️ Request ${request.id}: Error - ${request.failureReason}\n`, success: false };
  }
}

const processRequests = async (todayRequests: BookingRequest[], queueData: QueueData, queuePath: string) => {
  if (isTestMode && simulateBooking) {
    return await simulateProcessingRequests(todayRequests, queueData, queuePath)
  }
  return await processRealRequests(todayRequests, queueData, queuePath);
}

async function processQueue(): Promise<void> {
  log('Starting booking queue processing');
  log(`Running in ${isTestMode ? 'TEST' : 'PRODUCTION'} mode`);

  if (isTestMode) {
    createTestData();
  }

  const queueData = await initializeQueue();
  const todayRequests = filterTodayRequests(queueData);

  if (todayRequests.length === 0) {
    log(`No booking requests for today (${getTodayDate()})`);
    setOutput('processed_count', "0");
    setOutput('booking_status', 'success');
    setOutput('results', 'No booking requests for today.');
    console.log('processed_count=0' + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
    console.log('results=No booking requests for today.' + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
    return;
  }

  log(`Found ${todayRequests.length} booking requests for today`);

  const queuePath = getQueueFilePath();
  const { results, processedCount } = await processRequests(todayRequests, queueData, queuePath);

  log(`Processed ${processedCount} requests`);
  console.log(`processed_count=${processedCount}` + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
  console.log(`results=${results}` + (process.env.GITHUB_OUTPUT ? ' >> $GITHUB_OUTPUT' : ''));
  setOutput('processed_count', processedCount.toString());
  setOutput('booking_status', processedCount > 0 ? 'success' : 'failure');
  setOutput('results', results);
  logStream.end();
}

// Run the processor
processQueue()
  .catch(error => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stackTrace = error instanceof Error ? error.stack : 'No stack trace available';
    
    log(`FATAL ERROR: ${errorMessage}`);
    log(stackTrace || '');
    logStream.end();
    process.exit(1);
  });