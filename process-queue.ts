import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page, Browser, Frame } from '@playwright/test';
import { WriteStream } from 'fs';
import * as dotenv from 'dotenv';

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

type Slot = { time: string; id: string }

// Configuration
const headless = process.env.HEADLESS !== 'false';
const takeScreenshots = process.env.TAKE_SCREENSHOTS !== 'false';
const queueFilePath = path.join(__dirname, 'booking-queue.json');

// Logging setup
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
  const estDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const dateObj = new Date(estDate);
  const year = dateObj.getFullYear();
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const day = dateObj.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getCurrentTimeET = (): string => {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
};

// Sleep until specific time function
const sleepUntilTimeInZone = async (targetHour24: number, targetMinute: number, timeZoneIANA = 'America/New_York'): Promise<void> => {
    return new Promise((resolve, reject) => {
        const calculateDelay = () => {
            try {
                const now = new Date();

                const offsetFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: timeZoneIANA,
                    timeZoneName: 'longOffset',
                });
                const offsetParts = offsetFormatter.formatToParts(now);
                const offsetStringPart = offsetParts.find(part => part.type === 'timeZoneName');

                if (!offsetStringPart) {
                    throw new Error(`Could not determine timezone offset for '${timeZoneIANA}'`);
                }
                const offsetString = offsetStringPart.value;

                const offsetMatch = offsetString.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
                if (!offsetMatch) {
                    throw new Error(`Could not parse offset string: '${offsetString}'`);
                }

                const offsetSign = offsetMatch[1] === '+' ? 1 : -1;
                const offsetHours = parseInt(offsetMatch[2], 10);
                const offsetRuleMinutes = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;
                const totalOffsetMinutes = offsetSign * (offsetHours * 60 + offsetRuleMinutes);

                const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
                    timeZone: timeZoneIANA,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                });
                const currentDatePartsInZone = ymdFormatter.formatToParts(now).reduce<{[key: string]: number}>((acc, part) => {
                    if (part.type !== 'literal' && part.type !== 'timeZoneName') {
                        acc[part.type] = parseInt(part.value, 10);
                    }
                    return acc;
                }, {});

                let targetDateAttempt = new Date(Date.UTC(
                    currentDatePartsInZone.year,
                    currentDatePartsInZone.month - 1,
                    currentDatePartsInZone.day,
                    targetHour24,
                    targetMinute,
                    0, 0
                ));

                targetDateAttempt.setUTCMinutes(targetDateAttempt.getUTCMinutes() - totalOffsetMinutes);

                if (targetDateAttempt.getTime() <= now.getTime()) {
                    return 0;
                }

                const msUntilTarget = targetDateAttempt.getTime() - now.getTime();
                return msUntilTarget > 0 ? msUntilTarget : 0;

            } catch (error) {
                console.error("Error in calculateDelay:", error);
                reject(error);
                return null;
            }
        };

        const delay = calculateDelay();

        if (delay === null) {
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
};

// Queue management
async function initializeQueue(): Promise<QueueData> {
  if (!fs.existsSync(queueFilePath)) {
    log(`No booking queue file found. Creating empty queue.`);
    const emptyQueue: QueueData = {
      bookingRequests: [],
      processedRequests: []
    };
    fs.writeFileSync(queueFilePath, JSON.stringify(emptyQueue, null, 2));
    return emptyQueue;
  }
  return JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
}

function filterTodayRequests(queueData: QueueData): BookingRequest[] {
  const today = getTodayDate();
  const thirtyDaysFromToday = new Date(today);
  thirtyDaysFromToday.setDate(thirtyDaysFromToday.getDate() + 30);
  const thirtyDaysString = thirtyDaysFromToday.toISOString().split('T')[0];
  
  const threeDaysAfter = new Date(today);
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3);
  const threeDaysString = threeDaysAfter.toISOString().split('T')[0];
  
  const filteredRequests = queueData.bookingRequests.filter(request => {
    if (request.status !== 'pending') return false;
    const isExactly30Days = request.playDate === thirtyDaysString;
    const isWithin3Days = request.playDate >= today && request.playDate <= threeDaysString;
    return isExactly30Days || isWithin3Days;
  });
  
  return filteredRequests.sort((a, b) => b.playDate.localeCompare(a.playDate));
}

// Browser automation
async function loginToWebsite(page: Page, request: BookingRequest): Promise<void> {
  log('Logging in to golf course website');
  const username = process.env.GOLF_USERNAME;
  const password = process.env.GOLF_PASSWORD;
  
  if (!username || !password) {
    throw new Error('Golf course credentials not found in environment variables');
  }
  
  await page.goto('https://lorabaygolf.clubhouseonline-e3.com/TeeTimes/TeeSheet.aspx');
  await setDateInSessionStorage(page, request.playDate);
  await page.getByPlaceholder('Username').fill(username);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState('networkidle');
}

async function getBookingFrame(page: Page): Promise<Frame> {
  const iframeHandle = await page.locator('iframe#module').elementHandle();
  if (!iframeHandle) throw new Error('Booking iframe not found');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Unable to resolve content frame');
  return frame;
}

// Fallback date selection with clicking
async function selectDateWithClick(frame: Frame, targetDateText: string): Promise<boolean> {
  try {
    log(`Attempting to select date "${targetDateText}" by clicking`);
    
    const clicked = await frame.evaluate((dateText: string) => {
      const dateElements = document.querySelectorAll('div.item.ng-scope.slick-slide');
      for (const el of dateElements) {
        const dateDiv = el.querySelector('div.date.ng-binding');
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

// Check if tee times are not yet available
async function checkIfTooEarly(frame: Frame, playDate: string): Promise<boolean> {
  const pageText = await frame.evaluate(() => document.body.innerText);
  const datePattern = new Date(playDate).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const tooEarlyPattern = `will become available on ${datePattern} at 7:00 AM`;
  
  return pageText.includes(tooEarlyPattern);
}

// Find available slots with retry for "too early" case
async function findAvailableSlotsWithRetry(frame: Frame, timeRange: TimeRange, playDate: string, maxRetries = 10): Promise<Array<Slot>> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const slots = await findAvailableSlots(frame, timeRange);
    
    if (slots.length > 0) {
      return slots;
    }
    
    // Check if we're too early
    const tooEarly = await checkIfTooEarly(frame, playDate);
    if (tooEarly && attempt < maxRetries) {
      log(`Tee times not yet available (attempt ${attempt}/${maxRetries}), waiting 1 second...`);
      await frame.waitForTimeout(1000);
      await frame.goto(frame.url());
      await frame.waitForLoadState('networkidle');
    }

    return slots;
  }
  
  return [];
}

// Find available slots
async function findAvailableSlots(frame: Frame, timeRange: TimeRange): Promise<Slot[]> {
  return frame.evaluate(({ start, end }) => {
    const parseTime = (timeStr: string): number => {
      const [hour, minute] = timeStr.split(':').map(Number);
      return hour + minute / 60;
    };
    
    const startNum = parseTime(start);
    const endNum = parseTime(end);
    const slots: Array<{ time: string; id: string }> = [];
    let slotIdCounter = 0;
    
    const rows = document.querySelectorAll('div.flex-row.ng-scope:not(.unavailable)');
    
    for (const row of rows) {
      const availDiv = row.querySelector('div.availability.ng-scope strong.value.ng-binding');
      if (!availDiv || availDiv.textContent?.trim() !== '4') continue;
      
      const timeDiv = row.querySelector('div.teesheet-leftcol.ng-scope div.time.ng-binding');
      if (!timeDiv) continue;
      
      const timeMatch = timeDiv.textContent?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!timeMatch) continue;
      
      let hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2]);
      const isPM = timeMatch[3].toUpperCase() === 'PM';
      
      if (isPM && hour !== 12) hour += 12;
      if (!isPM && hour === 12) hour = 0;
      
      const slotTime = hour + minute / 60;
      if (slotTime < startNum || slotTime > endNum) continue;
      
      const formattedTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      
      // Set a unique ID on the element so we can find it later
      const uniqueId = `playwright-slot-${slotIdCounter++}`;
      if (timeDiv instanceof HTMLElement) {
        timeDiv.setAttribute('data-playwright-id', uniqueId);
      }
      
      slots.push({ time: formattedTime, id: uniqueId });
    }
    
    // Sort by time, prefer later times
    return slots.sort((a, b) => b.time.localeCompare(a.time));
  }, { start: timeRange.start, end: timeRange.end });
}


// Book slot - no retry needed as you mentioned
async function bookSlot(frame: Frame, slot: Slot): Promise<boolean> {
  try {
    // Click the time slot
    await frame.click(`[data-playwright-id="${slot.id}"]`);
    
    // Wait for booking form
    await frame.waitForSelector('a.btn.btn-primary:has-text("BOOK NOW")', { timeout: 2000 });
    
    // Complete booking
    await frame.getByText('ADD BUDDIES & GROUPS').click();
    await frame.getByText(/Test group \(\d+ people\)/i).click();
    
    // Click book now
    await frame.locator('a.btn.btn-primary:has-text("BOOK NOW")').click();
    log('Waiting for booking confirmation...');
    await frame.waitForLoadState('networkidle', { timeout: 5000 });
    return true;
  } catch (error) {
    log(`Booking failed: ${error}`);
    return false;
  }
}

const setDateInSessionStorage = async (page: Page, playDate: string): Promise<void> => {
      // Set the date in sessionStorage BEFORE navigating to booking page
    const [year, month, day] = playDate.split('-').map(Number);
    const dateObj = new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
    const isoDateStr = dateObj.toISOString();
    
    log(`Setting date ${playDate} in sessionStorage before navigation`);
    await page.evaluate((isoDate) => {
      window.sessionStorage.setItem('CHO.TT.selectedDate', `"${isoDate}"`);
    }, isoDateStr);
  }

const confirmDateSelection = async (request: BookingRequest, frame: Frame) => {
      // Verify the date was pre-selected
    const [year, month, day] = request.playDate.split('-').map(Number);
    const playDate = new Date(year, month - 1, day);
    const targetDateText = `${playDate.toLocaleString('en-US', { month: 'short' })} ${playDate.getDate()}`;
    
    const dateSelected = await frame.evaluate((expectedDate) => {
      const selectedEl = document.querySelector('div.item.ng-scope.slick-slide.date-selected');
      if (!selectedEl) return false;
      
      const dateDiv = selectedEl.querySelector('div.date.ng-binding');
      return dateDiv?.textContent?.includes(expectedDate) || false;
    }, targetDateText);
    
    if (!dateSelected) {
      log('Date not pre-selected, falling back to click method');
      return await selectDateWithClick(frame, targetDateText);
    }

    log('Date successfully pre-selected via sessionStorage');
    return true;
}

// Main processing function
async function processRequest(request: BookingRequest): Promise<{ message: string; success: boolean }> {
  let browser: Browser | null = null;
  
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();
    await loginToWebsite(page, request);
    log(`Logged in at ${getCurrentTimeET()}`);
    
    // Wait until 7:00 AM ET if scheduled run (do this BEFORE navigating to save time)
    if (process.env.IS_SCHEDULED_RUN === "true") {
      await sleepUntilTimeInZone(7, 0);
    }
    
    const frame = await getBookingFrame(page);
    const dateSelected = await confirmDateSelection(request, frame);
    if (!dateSelected) {
      request.status = 'failed';
      request.processedDate = new Date().toISOString();
      request.failureReason = 'Could not select date';
      return { 
        message: `❌ Request for ${request.playDate}: Failed to select date\n`, 
        success: false 
      };
    }

    // Find available slots with retry for "too early" case
    const slots = await findAvailableSlotsWithRetry(frame, request.timeRange, request.playDate);
    if (slots.length === 0) {
      request.status = 'failed';
      request.processedDate = new Date().toISOString();
      request.failureReason = 'No available times';
      return { 
        message: `❌ Request for ${request.playDate}: No available times at ${getCurrentTimeET()}\n`, 
        success: false 
      };
    }
    
    // Book the first available slot (latest time)
    const selectedSlot = slots[0];
    log(`Attempting to book ${selectedSlot.time}`);
    
    const booked = await bookSlot(frame, selectedSlot);
    if (!booked) {
      request.status = 'failed';
      request.processedDate = new Date().toISOString();
      request.failureReason = 'Failed to complete booking';
      return { 
        message: `❌ Request for ${request.playDate}: Booking failed\n`, 
        success: false 
      };
    }
    
    // Success
    request.status = 'success';
    request.processedDate = new Date().toISOString();
    request.bookedTime = selectedSlot.time;
    
    if (takeScreenshots) {
      const screenshotPath = path.join(logDir, `success-${request.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    
    return { 
      message: `✅ Request for ${request.playDate} booked for ${selectedSlot.time} at ${getCurrentTimeET()}\n`, 
      success: true 
    };
    
  } catch (error) {
    request.status = 'error';
    request.processedDate = new Date().toISOString();
    request.failureReason = error instanceof Error ? error.message : String(error);
    return { 
      message: `⚠️ Request ${request.id}: Error - ${request.failureReason}\n`, 
      success: false 
    };
  } finally {
    if (browser) await browser.close();
  }
}

// Main entry point
async function main(): Promise<void> {
  log('Starting booking queue processing');
  
  const queueData = await initializeQueue();
  const todayRequests = filterTodayRequests(queueData);
  
  if (todayRequests.length === 0) {
    log('No booking requests for today');
    setOutput('processed_count', '0');
    setOutput('booking_status', 'success');
    setOutput('results', 'No booking requests for today.');
    return;
  }
  
  log(`Found ${todayRequests.length} requests for today`);
  
  // Log the order we'll process them
  if (todayRequests.length > 0) {
    log('Processing order (furthest dates first for maximum competitiveness):');
    todayRequests.forEach(req => {
      log(`  - ${req.playDate} (${req.timeRange.start}-${req.timeRange.end})`);
    });
  }
  
  let results = '';
  let processedCount = 0;
  
  // Process requests sequentially for maximum speed
  for (const request of todayRequests) {
    const result = await processRequest(request);
    results += result.message;
    if (result.success) processedCount++;
  }
  
  // Update queue
  queueData.bookingRequests = queueData.bookingRequests.filter(r => r.status === 'pending');
  queueData.processedRequests = [...todayRequests, ...queueData.processedRequests];
  fs.writeFileSync(queueFilePath, JSON.stringify(queueData, null, 2));
  
  // Set outputs
  log(`Processed ${processedCount} requests`);
  setOutput('processed_count', processedCount.toString());
  setOutput('booking_status', processedCount > 0 ? 'success' : 'failure');
  setOutput('results', results);
  
  logStream.end();
}

// Run the processor
main().catch(error => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  log(`FATAL ERROR: ${errorMessage}`);
  log(error instanceof Error ? error.stack || '' : '');
  logStream.end();
  process.exit(1);
});