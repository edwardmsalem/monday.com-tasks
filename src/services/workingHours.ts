/**
 * Working Hours Utilities
 *
 * All times are in EST (America/New_York).
 * Core hours: 10 AM - 4 PM EST
 * Working days: Mon-Fri, excluding US federal holidays
 */

const TIMEZONE = 'America/New_York';

// Company Holidays for 2025-2026
// Format: YYYY-MM-DD
export const US_HOLIDAYS: string[] = [
  // 2025
  '2025-01-01', // New Year's Day
  '2025-11-27', // Thanksgiving
  '2025-11-28', // Black Friday
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-11-26', // Thanksgiving
  '2026-11-27', // Black Friday
  '2026-12-25', // Christmas
];

// Core working hours (for deadline calculations)
export const CORE_HOURS = {
  start: 10, // 10 AM EST
  end: 16,   // 4 PM EST (deadline)
};

// Extended hours (buffer to complete confirmed work)
export const EXTENDED_HOURS = {
  start: 10, // 10 AM EST
  end: 18,   // 6 PM EST
};

/**
 * Get the current date/time in EST
 */
export function getESTDate(date: Date = new Date()): Date {
  // Create a new date in EST timezone
  const estString = date.toLocaleString('en-US', { timeZone: TIMEZONE });
  return new Date(estString);
}

/**
 * Get the date string (YYYY-MM-DD) for a date in EST
 */
export function getESTDateString(date: Date = new Date()): string {
  const est = getESTDate(date);
  const year = est.getFullYear();
  const month = String(est.getMonth() + 1).padStart(2, '0');
  const day = String(est.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get the hour (0-23) in EST for a given date
 */
export function getESTHour(date: Date = new Date()): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour');
  return parseInt(hourPart?.value ?? '0', 10);
}

/**
 * Get the day of week (0=Sun, 6=Sat) in EST for a given date
 */
export function getESTDayOfWeek(date: Date = new Date()): number {
  const estDate = getESTDate(date);
  return estDate.getDay();
}

/**
 * Check if a date is a US federal holiday
 */
export function isHoliday(date: Date = new Date()): boolean {
  const dateString = getESTDateString(date);
  return US_HOLIDAYS.includes(dateString);
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 */
export function isWeekend(date: Date = new Date()): boolean {
  const dayOfWeek = getESTDayOfWeek(date);
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Check if a date is a business day (not weekend, not holiday)
 */
export function isBusinessDay(date: Date = new Date()): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

/**
 * Check if currently within core working hours (10 AM - 4 PM EST)
 */
export function isWorkingHours(date: Date = new Date()): boolean {
  if (!isBusinessDay(date)) {
    return false;
  }
  const hour = getESTHour(date);
  return hour >= CORE_HOURS.start && hour < CORE_HOURS.end;
}

/**
 * Check if currently within extended hours (10 AM - 6 PM EST)
 */
export function isExtendedHours(date: Date = new Date()): boolean {
  if (!isBusinessDay(date)) {
    return false;
  }
  const hour = getESTHour(date);
  return hour >= EXTENDED_HOURS.start && hour < EXTENDED_HOURS.end;
}

/**
 * Get the next business day from a given date
 */
export function getNextBusinessDay(from: Date = new Date()): Date {
  const result = new Date(from);
  result.setDate(result.getDate() + 1);

  // Keep advancing until we find a business day
  while (!isBusinessDay(result)) {
    result.setDate(result.getDate() + 1);
  }

  return result;
}

/**
 * Get the 4 PM deadline for a given date in EST
 * Returns a Date object representing 4 PM EST on that day
 */
export function get4PMDeadline(date: Date = new Date()): Date {
  const estDateString = getESTDateString(date);
  // Create a date at 4 PM EST
  // We need to handle timezone conversion carefully
  const deadline = new Date(`${estDateString}T16:00:00`);

  // Adjust for EST/EDT offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'short',
  });
  const parts = formatter.formatToParts(deadline);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value;
  const offset = tzName === 'EDT' ? -4 : -5; // EST is -5, EDT is -4

  // Create proper UTC date
  const utcHour = 16 - offset;
  return new Date(`${estDateString}T${String(utcHour).padStart(2, '0')}:00:00Z`);
}

/**
 * Get tomorrow's date (or Monday if today is Friday)
 * Returns the next business day if called on Friday or weekend
 */
export function getTomorrow(from: Date = new Date()): Date {
  return getNextBusinessDay(from);
}

/**
 * Calculate working hours between now and a deadline
 * Working hours: 10 AM - 4 PM EST, Mon-Fri, excluding holidays
 *
 * @param deadline - The deadline to calculate hours until
 * @param from - The starting time (defaults to now)
 * @returns Number of working hours remaining (can be fractional)
 */
export function getWorkingHoursUntil(deadline: Date, from: Date = new Date()): number {
  // If deadline is in the past, return 0
  if (deadline <= from) {
    return 0;
  }

  let totalHours = 0;
  const current = new Date(from);

  // Step through time in 1-hour increments
  while (current < deadline) {
    if (isBusinessDay(current)) {
      const hour = getESTHour(current);
      if (hour >= CORE_HOURS.start && hour < CORE_HOURS.end) {
        // Calculate partial hour if needed
        const nextHour = new Date(current);
        nextHour.setHours(nextHour.getHours() + 1);

        if (nextHour > deadline) {
          // Partial hour at the end
          const remainingMinutes = (deadline.getTime() - current.getTime()) / (1000 * 60);
          totalHours += remainingMinutes / 60;
        } else {
          totalHours += 1;
        }
      }
    }

    current.setHours(current.getHours() + 1);
  }

  return totalHours;
}

/**
 * Format a date for display in EST
 * Example: "Mon Jan 6" or "Mon Jan 6, 10:00 AM"
 */
export function formatDateEST(date: Date, includeTime: boolean = false): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };

  if (includeTime) {
    options.hour = 'numeric';
    options.minute = '2-digit';
    options.hour12 = true;
  }

  return date.toLocaleString('en-US', options);
}

/**
 * Get the day name for a date (e.g., "Monday", "Tuesday")
 */
export function getDayName(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
  });
}

/**
 * Check if a date is today (in EST)
 */
export function isToday(date: Date, now: Date = new Date()): boolean {
  return getESTDateString(date) === getESTDateString(now);
}

/**
 * Check if a date is tomorrow (in EST, accounting for weekends)
 * Friday → Monday counts as "tomorrow" for tomorrow prep
 */
export function isTomorrow(date: Date, now: Date = new Date()): boolean {
  const tomorrow = getTomorrow(now);
  return getESTDateString(date) === getESTDateString(tomorrow);
}

/**
 * Check if a date is within the next N days (in EST)
 */
export function isWithinDays(date: Date, days: number, now: Date = new Date()): boolean {
  const futureDate = new Date(now);
  futureDate.setDate(futureDate.getDate() + days);
  return date <= futureDate && date > now;
}

/**
 * Check if a date is in the past (overdue)
 */
export function isOverdue(dueDate: Date, now: Date = new Date()): boolean {
  const dueDateString = getESTDateString(dueDate);
  const nowDateString = getESTDateString(now);
  return dueDateString < nowDateString;
}

/**
 * Get the number of days late a task is
 * Returns 0 if not overdue
 */
export function getDaysLate(dueDate: Date, now: Date = new Date()): number {
  const dueDateString = getESTDateString(dueDate);
  const nowDateString = getESTDateString(now);

  const dueDateTime = new Date(dueDateString).getTime();
  const nowDateTime = new Date(nowDateString).getTime();

  if (nowDateTime <= dueDateTime) {
    return 0;
  }

  const diffMs = nowDateTime - dueDateTime;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays;
}

/**
 * Parse a date string (YYYY-MM-DD) into a Date object
 */
export function parseDate(dateString: string): Date {
  // Parse as EST noon to avoid timezone shift issues
  // Using noon ensures the date won't shift when converted between timezones
  const [year, month, day] = dateString.split('-').map(Number);

  // Create date at noon EST to be safe from timezone edge cases
  // This ensures "2026-01-08" stays "2026-01-08" regardless of server timezone
  const estNoon = new Date(Date.UTC(year, month - 1, day, 17, 0, 0)); // 17:00 UTC = 12:00 EST
  return estNoon;
}

/**
 * Get a time-specific Date for scheduling (e.g., 10:00 AM EST today)
 */
export function getScheduleTime(hour: number, minute: number = 0, date: Date = new Date()): Date {
  const estDateString = getESTDateString(date);

  // Determine timezone offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'short',
  });
  const parts = formatter.formatToParts(date);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value;
  const offset = tzName === 'EDT' ? -4 : -5;

  // Create proper UTC date
  const utcHour = hour - offset;
  const hourStr = String(utcHour).padStart(2, '0');
  const minStr = String(minute).padStart(2, '0');

  return new Date(`${estDateString}T${hourStr}:${minStr}:00Z`);
}
