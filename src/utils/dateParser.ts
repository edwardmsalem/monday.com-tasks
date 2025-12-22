/**
 * Date parsing utility
 * Handles multiple date formats from the email body:
 * - Relative: "+3" (3 days from now)
 * - Full date: "12/25/24" or "12/25/2024"
 * - Partial date: "12/25" (assumes current year)
 * - ASAP: treated as urgency, not a date
 */

/**
 * Check if a date string represents ASAP (no real date, just urgency)
 * Note: 'today' and '+0' are NOT ASAP - they should return today's actual date
 */
export function isAsapDate(dateStr: string): boolean {
  const trimmed = dateStr.trim().toLowerCase();
  return trimmed === 'asap' ||
         trimmed === 'immediately' ||
         trimmed === 'urgent' ||
         trimmed === 'now';
}

/**
 * Parse a date string and return ISO format (YYYY-MM-DD) or null for ASAP
 * @param dateStr - The date string to parse
 * @returns ISO formatted date string, or null if ASAP/no date
 */
export function parseDate(dateStr: string): string | null {
  const trimmed = dateStr.trim();

  // Handle ASAP-type dates - return null (no date, use urgency instead)
  if (isAsapDate(trimmed)) {
    console.log(`ASAP date detected: "${trimmed}" - no due date will be set, use urgency instead`);
    return null;
  }

  // Handle "today" - return today's date
  if (trimmed.toLowerCase() === 'today') {
    console.log(`"today" detected - setting due date to today`);
    return formatDate(new Date());
  }

  // Handle relative dates: "+3" means 3 days from now, "+0" means today
  if (trimmed.startsWith('+')) {
    const days = parseInt(trimmed.slice(1), 10);
    if (!isNaN(days)) {
      return addDays(new Date(), days);
    }
  }

  // Split by forward slash
  const parts = trimmed.split('/');

  if (parts.length === 3) {
    // Full date: MM/DD/YY or MM/DD/YYYY
    return parseFullDate(parts[0], parts[1], parts[2]);
  }

  if (parts.length === 2) {
    // Partial date: MM/DD (use current year)
    const currentYear = new Date().getFullYear().toString().slice(-2);
    return parseFullDate(parts[0], parts[1], currentYear);
  }

  // Fallback: return today's date
  console.warn(`Could not parse date: "${dateStr}", using today's date`);
  return formatDate(new Date());
}

/**
 * Parse full date parts into ISO format
 * If the resulting date is in the past, roll forward to next year
 */
function parseFullDate(month: string, day: string, year: string): string {
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  let y = parseInt(year, 10);

  // Handle 2-digit year
  if (y < 100) {
    y += 2000;
  }

  // Create date and format
  let date = new Date(y, m - 1, d);

  // If date is in the past, roll forward to next year
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date < today) {
    date = new Date(y + 1, m - 1, d);
  }

  return formatDate(date);
}

/**
 * Add days to a date and return ISO format
 */
function addDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return formatDate(result);
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format date for display (e.g., "Dec 25, 2024")
 * Returns "ASAP" for null dates
 */
export function formatDateForDisplay(isoDate: string | null): string {
  if (!isoDate) {
    return 'ASAP';
  }
  const date = new Date(isoDate + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
