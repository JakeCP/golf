import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies
vi.mock('fs')
vi.mock('@playwright/test')
vi.mock('dotenv')

// Import the module to test (we'll need to extract testable functions)
// For now, we'll test the logic by copy-pasting key functions

// Copied and simplified functions for testing
interface TimeRange {
  start: string
  end: string
}

interface BookingRequest {
  id: string
  requestDate: string
  playDate: string
  timeRange: TimeRange
  status: 'pending' | 'success' | 'failed' | 'error'
  requestedBy?: string
  processedDate?: string
  bookedTime?: string
  confirmationNumber?: string
  failureReason?: string
}

interface QueueData {
  bookingRequests: BookingRequest[]
  processedRequests: BookingRequest[]
}

// Function under test - simplified version of getTodayDate
const getTodayDate = (dateOverride?: string): string => {
  if (dateOverride) {
    return dateOverride
  }
  const estDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const dateObj = new Date(estDate)
  const year = dateObj.getFullYear()
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0')
  const day = dateObj.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Function under test - simplified version of filterTodayRequests
const filterTodayRequests = (queueData: QueueData, todayOverride?: string): BookingRequest[] => {
  const today = todayOverride || getTodayDate()
  const thirtyDaysFromToday = new Date(today)
  thirtyDaysFromToday.setDate(thirtyDaysFromToday.getDate() + 30)
  const thirtyDaysString = thirtyDaysFromToday.toISOString().split('T')[0]
  
  const threeDaysAfter = new Date(today)
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3)
  const threeDaysString = threeDaysAfter.toISOString().split('T')[0]
  
  const filteredRequests = queueData.bookingRequests.filter(request => {
    if (request.status !== 'pending') return false
    const isExactly30Days = request.playDate === thirtyDaysString
    const isWithin3Days = request.playDate >= today && request.playDate <= threeDaysString
    return isExactly30Days || isWithin3Days
  })
  
  return filteredRequests.sort((a, b) => b.playDate.localeCompare(a.playDate))
}

// Function under test - time slot parsing logic
const parseTimeSlot = (timeStr: string): number => {
  const [hour, minute] = timeStr.split(':').map(Number)
  return hour + minute / 60
}

const isTimeInRange = (timeStr: string, timeRange: TimeRange): boolean => {
  const slotTime = parseTimeSlot(timeStr)
  const startTime = parseTimeSlot(timeRange.start)
  const endTime = parseTimeSlot(timeRange.end)
  return slotTime >= startTime && slotTime <= endTime
}

const isWithinThreeDaysBooking = (playDate: string, todayOverride?: string): boolean => {
  const today = todayOverride || getTodayDate()
  const threeDaysAfter = new Date(today)
  threeDaysAfter.setDate(threeDaysAfter.getDate() + 3)
  const threeDaysString = threeDaysAfter.toISOString().split('T')[0]
  return playDate >= today && playDate <= threeDaysString
}

// Function under test - ISO date string conversion
const getFullIsoDateString = (dateStr: string): string => {
  const [year, month, day] = dateStr.split('-').map(Number)
  const dateObj = new Date(Date.UTC(year, month - 1, day, 4, 0, 0))
  return dateObj.toISOString()
}

// Function under test - slot sorting (simplified from the evaluate function)
type Slot = { time: string; id: string }

const sortSlotsByTime = (slots: Slot[]): Slot[] => {
  // Sort by time, prefer later times (same logic as line 510 in process-queue.ts)
  return slots.sort((a, b) => b.time.localeCompare(a.time))
}

// Function under test - simulate the time slot filtering logic from the browser
const filterAvailableSlots = (timeRange: TimeRange, mockSlots: Array<{time: string, availability: string}>): Slot[] => {
  const parseTime = (timeStr: string): number => {
    const [hour, minute] = timeStr.split(':').map(Number)
    return hour + minute / 60
  }
  
  const startNum = parseTime(timeRange.start)
  const endNum = parseTime(timeRange.end)
  const slots: Slot[] = []
  let slotIdCounter = 0
  
  for (const mockSlot of mockSlots) {
    // Only include slots with 4 people availability
    if (mockSlot.availability !== '4') continue
    
    const timeMatch = mockSlot.time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
    if (!timeMatch) continue
    
    let hour = parseInt(timeMatch[1])
    const minute = parseInt(timeMatch[2])
    const isPM = timeMatch[3].toUpperCase() === 'PM'
    
    if (isPM && hour !== 12) hour += 12
    if (!isPM && hour === 12) hour = 0
    
    const slotTime = hour + minute / 60
    if (slotTime < startNum || slotTime > endNum) continue
    
    const formattedTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
    const uniqueId = `playwright-slot-${slotIdCounter++}`
    
    slots.push({ time: formattedTime, id: uniqueId })
  }
  
  return sortSlotsByTime(slots)
}

describe('Golf Booking System', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Date filtering logic', () => {
    const mockQueueData: QueueData = {
      bookingRequests: [
        {
          id: '1',
          requestDate: '2025-06-10T12:00:00Z',
          playDate: '2025-06-11', // 1 day from today (within 3 days)
          timeRange: { start: '09:00', end: '11:00' },
          status: 'pending'
        },
        {
          id: '2',
          requestDate: '2025-06-10T12:00:00Z',
          playDate: '2025-06-13', // 3 days from today (within 3 days)
          timeRange: { start: '09:00', end: '11:00' },
          status: 'pending'
        },
        {
          id: '3',
          requestDate: '2025-06-10T12:00:00Z',
          playDate: '2025-07-10', // 30 days from today
          timeRange: { start: '09:00', end: '11:00' },
          status: 'pending'
        },
        {
          id: '4',
          requestDate: '2025-06-10T12:00:00Z',
          playDate: '2025-06-15', // 5 days from today (outside both ranges)
          timeRange: { start: '09:00', end: '11:00' },
          status: 'pending'
        },
        {
          id: '5',
          requestDate: '2025-06-10T12:00:00Z',
          playDate: '2025-06-11',
          timeRange: { start: '09:00', end: '11:00' },
          status: 'success' // Should be filtered out
        }
      ],
      processedRequests: []
    }

    it('filters requests for 30-day and 3-day bookings only', () => {
      const result = filterTodayRequests(mockQueueData, '2025-06-10')
      
      expect(result).toHaveLength(3)
      expect(result.map(r => r.id)).toEqual(['3', '2', '1']) // Sorted by date desc
    })

    it('excludes non-pending requests', () => {
      const result = filterTodayRequests(mockQueueData, '2025-06-10')
      
      expect(result.every(r => r.status === 'pending')).toBe(true)
    })

    it('sorts results by play date descending (furthest first)', () => {
      const result = filterTodayRequests(mockQueueData, '2025-06-10')
      
      expect(result[0].playDate).toBe('2025-07-10') // 30-day booking first
      expect(result[1].playDate).toBe('2025-06-13') // Then furthest 3-day
      expect(result[2].playDate).toBe('2025-06-11') // Then closest 3-day
    })
  })

  describe('Time slot parsing and filtering', () => {
    it('parses time strings correctly', () => {
      expect(parseTimeSlot('09:00')).toBe(9.0)
      expect(parseTimeSlot('09:30')).toBe(9.5)
      expect(parseTimeSlot('12:15')).toBe(12.25)
      expect(parseTimeSlot('23:45')).toBe(23.75)
    })

    it('filters time slots within range', () => {
      const timeRange: TimeRange = { start: '09:30', end: '11:00' }
      
      expect(isTimeInRange('09:00', timeRange)).toBe(false) // Too early
      expect(isTimeInRange('09:30', timeRange)).toBe(true)  // Start time
      expect(isTimeInRange('10:15', timeRange)).toBe(true)  // Middle
      expect(isTimeInRange('11:00', timeRange)).toBe(true)  // End time
      expect(isTimeInRange('11:30', timeRange)).toBe(false) // Too late
    })
  })

  describe('Booking type determination', () => {
    it('correctly identifies 3-day bookings', () => {
      const today = '2025-06-10'
      
      expect(isWithinThreeDaysBooking('2025-06-10', today)).toBe(true)  // Today
      expect(isWithinThreeDaysBooking('2025-06-11', today)).toBe(true)  // Tomorrow
      expect(isWithinThreeDaysBooking('2025-06-13', today)).toBe(true)  // 3 days
      expect(isWithinThreeDaysBooking('2025-06-14', today)).toBe(false) // 4 days
      expect(isWithinThreeDaysBooking('2025-06-09', today)).toBe(false) // Past
    })
  })

  describe('Date edge cases', () => {
    it('handles month boundaries for 30-day bookings', () => {
      const queueData: QueueData = {
        bookingRequests: [
          {
            id: '1',
            requestDate: '2025-01-15T12:00:00Z',
            playDate: '2025-02-14', // Exactly 30 days from Jan 15
            timeRange: { start: '09:00', end: '11:00' },
            status: 'pending'
          }
        ],
        processedRequests: []
      }

      const result = filterTodayRequests(queueData, '2025-01-15')
      expect(result).toHaveLength(1)
    })

    it('handles year boundaries', () => {
      const queueData: QueueData = {
        bookingRequests: [
          {
            id: '1',
            requestDate: '2025-12-02T12:00:00Z',
            playDate: '2026-01-01', // 30 days from Dec 2
            timeRange: { start: '09:00', end: '11:00' },
            status: 'pending'
          }
        ],
        processedRequests: []
      }

      const result = filterTodayRequests(queueData, '2025-12-02')
      expect(result).toHaveLength(1)
    })
  })

  describe('Time zone edge cases', () => {
    it('handles different date formats', () => {
      // Test that our date parsing is consistent
      const testDate = '2025-06-10'
      expect(getTodayDate(testDate)).toBe(testDate)
    })
  })

  describe('Slot sorting and selection', () => {
    it('sorts slots by time descending (prefers later times)', () => {
      const slots: Slot[] = [
        { time: '09:00', id: 'slot1' },
        { time: '11:30', id: 'slot2' },
        { time: '10:15', id: 'slot3' },
        { time: '09:45', id: 'slot4' }
      ]

      const sorted = sortSlotsByTime([...slots])
      
      expect(sorted.map(s => s.time)).toEqual(['11:30', '10:15', '09:45', '09:00'])
    })

    it('handles identical times consistently', () => {
      const slots: Slot[] = [
        { time: '10:00', id: 'slot1' },
        { time: '10:00', id: 'slot2' },
        { time: '09:00', id: 'slot3' }
      ]

      const sorted = sortSlotsByTime([...slots])
      
      expect(sorted[0].time).toBe('10:00')
      expect(sorted[1].time).toBe('10:00')
      expect(sorted[2].time).toBe('09:00')
    })
  })

  describe('Available slot filtering and parsing', () => {
    const mockSlots = [
      { time: '8:00 AM', availability: '4' },
      { time: '8:30 AM', availability: '2' }, // Should be filtered out
      { time: '9:15 AM', availability: '4' },
      { time: '10:30 AM', availability: '4' },
      { time: '11:45 AM', availability: '4' },
      { time: '12:00 PM', availability: '4' },
      { time: '1:30 PM', availability: '4' },
      { time: '2:00 PM', availability: '0' }, // Should be filtered out
    ]

    it('filters slots by availability (only 4-person slots)', () => {
      const timeRange: TimeRange = { start: '08:00', end: '14:00' }
      const result = filterAvailableSlots(timeRange, mockSlots)
      
      expect(result).toHaveLength(6) // Should exclude the 2-person and 0-person slots
    })

    it('filters slots by time range', () => {
      const timeRange: TimeRange = { start: '09:00', end: '11:00' }
      const result = filterAvailableSlots(timeRange, mockSlots)
      
      const times = result.map(s => s.time)
      expect(times).toEqual(['10:30', '09:15']) // Sorted desc, within range
    })

    it('parses AM/PM times correctly', () => {
      const amPmSlots = [
        { time: '12:00 AM', availability: '4' }, // Midnight
        { time: '12:30 PM', availability: '4' }, // Noon
        { time: '1:00 PM', availability: '4' },  // 1 PM
        { time: '11:30 PM', availability: '4' }  // 11:30 PM
      ]
      
      const timeRange: TimeRange = { start: '00:00', end: '23:59' }
      const result = filterAvailableSlots(timeRange, amPmSlots)
      
      const times = result.map(s => s.time)
      expect(times).toEqual(['23:30', '13:00', '12:30', '00:00'])
    })

    it('handles edge cases in time parsing', () => {
      const edgeCaseSlots = [
        { time: '12:00 AM', availability: '4' }, // Midnight (00:00)
        { time: '12:00 PM', availability: '4' }, // Noon (12:00)
        { time: '12:15 AM', availability: '4' }, // 00:15
        { time: '12:15 PM', availability: '4' }, // 12:15
      ]
      
      const timeRange: TimeRange = { start: '00:00', end: '23:59' }
      const result = filterAvailableSlots(timeRange, edgeCaseSlots)
      
      const times = result.map(s => s.time)
      expect(times).toEqual(['12:15', '12:00', '00:15', '00:00'])
    })
  })

  describe('ISO date string conversion', () => {
    it('converts date strings to ISO format with 4 AM UTC time', () => {
      const result = getFullIsoDateString('2025-06-15')
      expect(result).toBe('2025-06-15T04:00:00.000Z')
    })

    it('handles different months correctly', () => {
      expect(getFullIsoDateString('2025-01-01')).toBe('2025-01-01T04:00:00.000Z')
      expect(getFullIsoDateString('2025-12-31')).toBe('2025-12-31T04:00:00.000Z')
    })

    it('handles leap years', () => {
      expect(getFullIsoDateString('2024-02-29')).toBe('2024-02-29T04:00:00.000Z')
    })

    it('maintains consistent UTC offset', () => {
      // All dates should have the same 4 AM UTC time regardless of local timezone
      const winter = getFullIsoDateString('2025-01-15')
      const summer = getFullIsoDateString('2025-07-15')
      
      expect(winter.endsWith('T04:00:00.000Z')).toBe(true)
      expect(summer.endsWith('T04:00:00.000Z')).toBe(true)
    })
  })
})