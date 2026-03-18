/**
 * Google Sheets Service
 *
 * Creates spreadsheets for presale/relocation tracking
 * with recipient emails and appointment times
 *
 * All operations go through core-api (centralized Google API access)
 */

import { config, configCompat } from '../config/environment.js';
import type { RecipientWithAppointment } from './gmail.js';
import { google as coreApiGoogle } from './coreApi.js';
import { detectEventType } from './calendar.js';

/**
 * Safely share a sheet with anyone in the workspace domain via core-api.
 * If sharing fails (e.g., due to workspace restrictions), logs a warning but continues.
 * @returns true if sharing succeeded, false if it failed
 */
async function safeShareSheet(spreadsheetId: string): Promise<boolean> {
  try {
    const domain = config.google.workspaceDomain;
    await coreApiGoogle.drive.shareFile(spreadsheetId, {
      role: 'writer',
      type: 'domain',
      domain,
    });
    console.log(`[Sheets] Shared sheet with ${domain} workspace`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Sheets] Failed to share sheet with workspace: ${errorMessage}`);
    return false;
  }
}

/**
 * Convert ISO datetime string to Google Sheets date serial number
 * Google Sheets uses days since Dec 30, 1899
 */
function isoToSheetDate(isoDateTime: string | null | undefined): number | string {
  if (!isoDateTime) return '';
  try {
    const date = new Date(isoDateTime);
    if (isNaN(date.getTime())) return '';
    // Google Sheets epoch is Dec 30, 1899
    const sheetsEpoch = new Date(1899, 11, 30);
    const days = (date.getTime() - sheetsEpoch.getTime()) / (1000 * 60 * 60 * 24);
    return days;
  } catch {
    return '';
  }
}

/**
 * Convert ISO datetime string to Google Sheets time serial number
 * Time is represented as fraction of a day (0.5 = noon)
 */
function isoToSheetTime(isoDateTime: string | null | undefined): number | string {
  if (!isoDateTime) return '';
  try {
    const date = new Date(isoDateTime);
    if (isNaN(date.getTime())) return '';
    // Get time as fraction of day
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    return (hours + minutes / 60 + seconds / 3600) / 24;
  } catch {
    return '';
  }
}

export interface SheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
}

export type ScanContentType = 'relocation' | 'presale' | 'generic';

/**
 * Detect content type from email subject
 * Used to determine which columns to include in the scan sheet
 */
export function detectContentType(subject: string): ScanContentType {
  const lowerSubject = subject.toLowerCase();
  if (lowerSubject.includes('relocation') || lowerSubject.includes('selection')) {
    return 'relocation';
  }
  if (lowerSubject.includes('presale') || lowerSubject.includes('pre-sale')) {
    return 'presale';
  }
  return 'generic';
}

/**
 * Create a Google Sheet with recipient appointment data
 */
export async function createRecipientSheet(
  title: string,
  recipients: RecipientWithAppointment[]
): Promise<SheetResult> {
  // Create the spreadsheet via core-api
  const createResponse = await coreApiGoogle.sheets.createWithOptions({
    title: title,
    sheets: [
      {
        title: 'Recipients',
        frozenRowCount: 1, // Freeze header row
      },
    ],
  });

  const spreadsheetId = createResponse.spreadsheetId;
  const spreadsheetUrl = createResponse.spreadsheetUrl;
  const sheetId = createResponse.sheets?.[0]?.sheetId ?? 0;

  // Build the data rows with proper date/time values
  const headerRow = ['Email', 'Date', 'Time', 'Status', 'Notes'];
  const dataRows = recipients.map(r => [
    r.email,
    isoToSheetDate(r.rawDateTime),
    isoToSheetTime(r.rawDateTime),
    '', // Status column for manual tracking
    '', // Notes column
  ]);

  // Add data to the sheet
  await coreApiGoogle.sheets.updateValues(spreadsheetId, {
    range: 'Recipients!A1',
    values: [headerRow, ...dataRows],
  });

  // Format the header row and apply date/time formatting
  const dataRowCount = recipients.length;
  await coreApiGoogle.sheets.batchUpdate(spreadsheetId, [
    // Header row formatting (bold, background color)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.2, green: 0.4, blue: 0.8 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Date column formatting (column B = index 1)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: dataRowCount + 1,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: 'DATE',
              pattern: 'ddd M/d',
            },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // Time column formatting (column C = index 2)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: dataRowCount + 1,
          startColumnIndex: 2,
          endColumnIndex: 3,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: 'TIME',
              pattern: 'h:mm AM/PM',
            },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // Auto-resize columns
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: 5,
        },
      },
    },
  ]);

  // Try to make the sheet accessible to anyone with the link
  // (may fail if workspace restricts external sharing)
  const shared = await safeShareSheet(spreadsheetId);
  console.log(`Created Google Sheet: ${spreadsheetUrl}${shared ? '' : ' (not shared publicly - workspace restriction)'}`);

  return {
    spreadsheetId,
    spreadsheetUrl,
    title,
  };
}

/**
 * Options for creating a scan sheet
 */
export interface ScanSheetOptions {
  title: string;
  recipients: RecipientWithAppointment[];
  contentType: ScanContentType;
  accountInfo?: Map<string, ScanAccountInfo>;  // email → account info for scanned recipients
  allAccounts?: Map<string, ScanAccountInfo>;  // ALL accounts from team sheet (for "no appointment" section)
  teamName?: string;  // resolved team name from client (e.g. "San Jose Sharks")
}

/**
 * Assign pack labels to rows with adjacent seats.
 * Groups rows by normalized section|row, sorts by lowSeat,
 * and marks adjacent chains as "Pack 1", "Pack 2", etc.
 * Mutates rows in place (sets packCol value).
 */
function assignPacks(
  rows: (string | number)[][],
  sectionCol: number,
  rowCol: number,
  lowSeatCol: number,
  highSeatCol: number,
  packCol: number
): void {
  // Index rows by section|row key
  const groups = new Map<string, { idx: number; low: number; high: number }[]>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const section = String(row[sectionCol] || '').toLowerCase().trim();
    const rowVal = String(row[rowCol] || '').toLowerCase().trim();
    const low = parseInt(String(row[lowSeatCol]), 10);
    const high = parseInt(String(row[highSeatCol]), 10);
    if (!section || !rowVal || isNaN(low) || isNaN(high)) continue;

    const key = `${section}|${rowVal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ idx: i, low, high });
  }

  let packNumber = 0;

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;

    // Sort by lowSeat ascending
    entries.sort((a, b) => a.low - b.low);

    // Find adjacent chains
    let chainStart = 0;
    for (let i = 1; i <= entries.length; i++) {
      const isAdjacent = i < entries.length && entries[i - 1].high + 1 === entries[i].low;
      if (!isAdjacent) {
        // End of chain — only label if chain has 2+ entries
        const chainLen = i - chainStart;
        if (chainLen >= 2) {
          packNumber++;
          const label = `Pack ${packNumber}`;
          for (let j = chainStart; j < i; j++) {
            rows[entries[j].idx][packCol] = label;
          }
        }
        chainStart = i;
      }
    }
  }

  if (packNumber > 0) {
    console.log(`[Sheets] Assigned ${packNumber} pack(s) across rows`);
  }
}

/**
 * Create a Google Sheet for /scan results
 *
 * When accountInfo is provided (from batchLookupAccountsForScan), uses it to
 * populate Name, Section, Row, Seats, Qty columns. Multiple seat sets per
 * account = multiple rows.
 *
 * Sheet columns (with accountInfo): Date | Time | Email | Name | Section | Row | Seats | Qty | Status | Notes
 * Sheet columns (without):          Date | Time | Email | Status | Notes
 */
export async function createScanSheet(options: ScanSheetOptions): Promise<SheetResult> {
  const { title: subject, recipients, contentType } = options;

  const currentYear = new Date().getFullYear();
  const eventType = detectEventType(subject);
  const name = options.teamName || subject;
  const title = `${name} ${eventType} ${currentYear}`;

  // Build an email → appointment time lookup from scanned recipients
  const appointmentByEmail = new Map<string, RecipientWithAppointment>();
  for (const r of recipients) {
    if (r.rawDateTime) {
      appointmentByEmail.set(r.email.toLowerCase(), r);
    }
  }

  let headerRow: string[];
  let dataRows: (string | number)[][];
  let columnCount: number;

  if (options.accountInfo && options.accountInfo.size > 0) {
    // Use pre-fetched accountInfo from batchLookupAccountsForScan
    console.log(`[Sheets] Building sheet with accountInfo for "${name}" (${options.accountInfo.size} accounts)`);
    headerRow = ['Date', 'Time', 'Email', 'Name', 'Section', 'Row', 'Low Seat', 'High Seat', 'Qty', 'Pack', 'Season Total', 'Last 4', 'Exp', 'CVV', 'Billing Address', 'Status', 'Notes'];
    columnCount = headerRow.length;

    const rowsWithTimes: { sortKey: number; row: (string | number)[] }[] = [];

    for (const recipient of recipients) {
      const email = recipient.email.toLowerCase();
      const account = options.accountInfo.get(email);
      const appointment = appointmentByEmail.get(email);

      const dateValue = appointment ? isoToSheetDate(appointment.rawDateTime) : '';
      const timeValue = appointment ? isoToSheetTime(appointment.rawDateTime) : '';
      const sortKey = appointment?.rawDateTime
        ? new Date(appointment.rawDateTime).getTime()
        : Number.MAX_SAFE_INTEGER;

      if (account && account.seatLocations.length > 0) {
        // One row per seat location (same account may have multiple seat sets)
        for (const loc of account.seatLocations) {
          const lowSeatStr = loc.lowSeat ? String(loc.lowSeat) : '';
          const highSeatStr = loc.highSeat ? String(loc.highSeat) : '';
          rowsWithTimes.push({
            sortKey,
            row: [dateValue, timeValue, recipient.email, account.name,
              loc.section, loc.row, lowSeatStr, highSeatStr, loc.qty, '', loc.seasonTotal,
              account.last4, account.exp, account.cvv, account.billingAddress,
              '', ''],
          });
        }
      } else if (account) {
        rowsWithTimes.push({
          sortKey,
          row: [dateValue, timeValue, recipient.email, account.name,
            '', '', '', '', '', '', '',
            account.last4, account.exp, account.cvv, account.billingAddress,
            '', ''],
        });
      } else {
        rowsWithTimes.push({
          sortKey,
          row: [dateValue, timeValue, recipient.email, '',
            '', '', '', '', '', '', '',
            '', '', '', '',
            '', ''],
        });
      }
    }

    // Sort: accounts with appointment times first (ascending), then accounts without
    rowsWithTimes.sort((a, b) => a.sortKey - b.sortKey);
    dataRows = rowsWithTimes.map(r => r.row);

    console.log(`[Sheets] Built ${dataRows.length} rows from accountInfo (${appointmentByEmail.size} with appointment times)`);

    // --- Pack detection (second pass) ---
    // Runs after all scanned rows are built; will also run on noAppointment rows later
    assignPacks(dataRows, 4, 5, 6, 7, 9); // section=4, row=5, lowSeat=6, highSeat=7, packCol=9
  } else {
    // Fallback: no accountInfo available, simple format
    console.log(`[Sheets] No accountInfo for "${name}", using simple format`);
    headerRow = ['Date', 'Time', 'Email', 'Status', 'Notes'];
    columnCount = headerRow.length;

    const sorted = [...recipients].sort((a, b) => {
      if (!a.rawDateTime && !b.rawDateTime) return 0;
      if (!a.rawDateTime) return 1;
      if (!b.rawDateTime) return -1;
      return new Date(a.rawDateTime).getTime() - new Date(b.rawDateTime).getTime();
    });

    dataRows = sorted.map(r => [
      isoToSheetDate(r.rawDateTime),
      isoToSheetTime(r.rawDateTime),
      r.email,
      '', // Status
      '', // Notes
    ]);
  }

  // Append custom columns if any recipients have custom extracted data
  const allCustomKeys: string[] = [];
  const customKeysSet = new Set<string>();
  for (const r of recipients) {
    if (r.custom) {
      for (const key of Object.keys(r.custom)) {
        if (!customKeysSet.has(key)) {
          customKeysSet.add(key);
          allCustomKeys.push(key);
        }
      }
    }
  }

  if (allCustomKeys.length > 0) {
    // Capitalize custom key names for column headers
    const customHeaders = allCustomKeys.map(k => k.charAt(0).toUpperCase() + k.slice(1));
    headerRow.push(...customHeaders);
    columnCount = headerRow.length;

    // Append custom values to each data row, matching by email column
    const emailColIdx = headerRow.indexOf('Email');
    for (const row of dataRows) {
      const rowEmail = String(row[emailColIdx]).toLowerCase();
      const recipient = recipients.find(r => r.email.toLowerCase() === rowEmail);
      for (const key of allCustomKeys) {
        row.push(recipient?.custom?.[key] ?? '');
      }
    }

    console.log(`[Sheets] Added ${allCustomKeys.length} custom columns: ${allCustomKeys.join(', ')}`);
  }

  // Build "No Appointment" section: accounts from the team sheet that weren't scanned
  // Include only accounts whose status is NOT "Not Active", "Revoked", or "Deposit"
  const excludedStatuses = ['not active', 'revoked', 'deposit'];
  let noAppointmentRows: (string | number)[][] = [];

  if (options.allAccounts && options.allAccounts.size > 0) {
    const scannedEmails = new Set(recipients.map(r => r.email.toLowerCase()));

    for (const [email, account] of options.allAccounts.entries()) {
      if (scannedEmails.has(email)) continue; // Already in scan results
      const statusLower = (account.status || '').toLowerCase().trim();
      if (excludedStatuses.includes(statusLower)) continue;

      // One row per seat location (same as scanned section)
      if (account.seatLocations.length > 0) {
        for (const loc of account.seatLocations) {
          const lowSeatStr = loc.lowSeat ? String(loc.lowSeat) : '';
          const highSeatStr = loc.highSeat ? String(loc.highSeat) : '';
          const row: (string | number)[] = options.accountInfo && options.accountInfo.size > 0
            ? ['', '', email, account.name, loc.section, loc.row, lowSeatStr, highSeatStr, loc.qty, '', loc.seasonTotal || '', account.last4, account.exp, account.cvv, account.billingAddress, account.status || '', '']
            : ['', '', email, account.status || '', ''];
          noAppointmentRows.push(row);
        }
      } else {
        const row: (string | number)[] = options.accountInfo && options.accountInfo.size > 0
          ? ['', '', email, account.name, '', '', '', '', '', '', '', account.last4, account.exp, account.cvv, account.billingAddress, account.status || '', '']
          : ['', '', email, account.status || '', ''];
        noAppointmentRows.push(row);
      }
    }

    if (noAppointmentRows.length > 0) {
      // Run pack detection across all rows (scanned + no-appointment) together
      if (options.accountInfo && options.accountInfo.size > 0) {
        assignPacks([...dataRows, ...noAppointmentRows], 4, 5, 6, 7, 9);
      }

      // Add a blank separator row + section header
      const separatorRow = new Array(columnCount).fill('');
      const sectionHeaderRow = new Array(columnCount).fill('');
      sectionHeaderRow[0] = `NO APPOINTMENT (${noAppointmentRows.length})`;
      dataRows.push(separatorRow, sectionHeaderRow, ...noAppointmentRows);
      console.log(`[Sheets] Added ${noAppointmentRows.length} "No Appointment" rows`);
    }
  }

  // Create the spreadsheet via core-api
  const createResponse = await coreApiGoogle.sheets.createWithOptions({
    title: title,
    sheets: [
      {
        title: 'Recipients',
        frozenRowCount: 1,
      },
    ],
  });

  const spreadsheetId = createResponse.spreadsheetId;
  const spreadsheetUrl = createResponse.spreadsheetUrl;
  const sheetId = createResponse.sheets?.[0]?.sheetId ?? 0;

  // Add data to the sheet
  await coreApiGoogle.sheets.updateValues(spreadsheetId, {
    range: 'Recipients!A1',
    values: [headerRow, ...dataRows],
  });

  // Format the header row and apply date/time formatting
  const dataRowCount = dataRows.length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const formatRequests: any[] = [
    // Header row formatting (bold, white text on blue background)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.2, green: 0.4, blue: 0.8 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Date column formatting (column A = index 0)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: dataRowCount + 1,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: 'DATE',
              pattern: 'ddd M/d',
            },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // Time column formatting (column B = index 1)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: dataRowCount + 1,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: 'TIME',
              pattern: 'h:mm AM/PM',
            },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // Auto-resize columns
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: columnCount,
        },
      },
    },
  ];

  await coreApiGoogle.sheets.batchUpdate(spreadsheetId, formatRequests);

  // Try to make the sheet accessible to anyone with the link
  const shared = await safeShareSheet(spreadsheetId);
  console.log(`[Sheets] Created scan sheet: ${spreadsheetUrl} (type: ${contentType}, accountInfo: ${options.accountInfo?.size ? 'yes' : 'no'}, rows: ${dataRowCount})${shared ? '' : ' (not shared publicly - workspace restriction)'}`);

  return {
    spreadsheetId,
    spreadsheetUrl,
    title,
  };
}


// ============================================================================
// ACCOUNT LOOKUP FEATURE
// Lookup account info from sport-specific Google Sheets workbooks
// ============================================================================

export type Sport = 'mlb' | 'nfl' | 'nba' | 'wnba' | 'nhl' | 'mls' | 'ncaa' | 'other';

/**
 * Team to sport mapping
 * Keys are lowercase, can be partial names (e.g., "astros" or "houston astros")
 */
const TEAM_SPORT_MAP: Record<string, Sport> = {
  // MLB Teams
  'astros': 'mlb', 'houston astros': 'mlb',
  'texas rangers': 'mlb',  // "rangers" alone is ambiguous with NY Rangers (NHL)
  'yankees': 'mlb', 'new york yankees': 'mlb',
  'mets': 'mlb', 'new york mets': 'mlb',
  'dodgers': 'mlb', 'los angeles dodgers': 'mlb', 'la dodgers': 'mlb',
  'angels': 'mlb', 'los angeles angels': 'mlb', 'la angels': 'mlb',
  'red sox': 'mlb', 'boston red sox': 'mlb',
  'cubs': 'mlb', 'chicago cubs': 'mlb',
  'white sox': 'mlb', 'chicago white sox': 'mlb',
  'braves': 'mlb', 'atlanta braves': 'mlb',
  'phillies': 'mlb', 'philadelphia phillies': 'mlb',
  'san francisco giants': 'mlb', 'sf giants': 'mlb',  // "giants" alone is ambiguous with NY Giants
  'st louis cardinals': 'mlb', 'stl cardinals': 'mlb',  // "cardinals" alone is ambiguous with Arizona Cardinals
  'padres': 'mlb', 'san diego padres': 'mlb',
  'mariners': 'mlb', 'seattle mariners': 'mlb',
  'twins': 'mlb', 'minnesota twins': 'mlb',
  'guardians': 'mlb', 'cleveland guardians': 'mlb',
  'tigers': 'mlb', 'detroit tigers': 'mlb',
  'royals': 'mlb', 'kansas city royals': 'mlb', 'kc royals': 'mlb',
  'orioles': 'mlb', 'baltimore orioles': 'mlb',
  'rays': 'mlb', 'tampa bay rays': 'mlb',
  'blue jays': 'mlb', 'toronto blue jays': 'mlb',
  'nationals': 'mlb', 'washington nationals': 'mlb',
  'marlins': 'mlb', 'miami marlins': 'mlb',
  'brewers': 'mlb', 'milwaukee brewers': 'mlb',
  'reds': 'mlb', 'cincinnati reds': 'mlb',
  'pirates': 'mlb', 'pittsburgh pirates': 'mlb',
  'diamondbacks': 'mlb', 'arizona diamondbacks': 'mlb', 'dbacks': 'mlb',
  'rockies': 'mlb', 'colorado rockies': 'mlb',
  'athletics': 'mlb', 'oakland athletics': 'mlb', 'as': 'mlb',

  // NFL Teams
  'texans': 'nfl', 'houston texans': 'nfl',
  'cowboys': 'nfl', 'dallas cowboys': 'nfl',
  'eagles': 'nfl', 'philadelphia eagles': 'nfl',
  'chiefs': 'nfl', 'kansas city chiefs': 'nfl', 'kc chiefs': 'nfl',
  'bills': 'nfl', 'buffalo bills': 'nfl',
  'dolphins': 'nfl', 'miami dolphins': 'nfl',
  'patriots': 'nfl', 'new england patriots': 'nfl',
  'jets': 'nfl', 'new york jets': 'nfl', 'ny jets': 'nfl',
  'new york giants': 'nfl', 'ny giants': 'nfl',  // "giants" alone is ambiguous with SF Giants
  'ravens': 'nfl', 'baltimore ravens': 'nfl',
  'bengals': 'nfl', 'cincinnati bengals': 'nfl',
  'browns': 'nfl', 'cleveland browns': 'nfl',
  'steelers': 'nfl', 'pittsburgh steelers': 'nfl',
  'colts': 'nfl', 'indianapolis colts': 'nfl',
  'jaguars': 'nfl', 'jacksonville jaguars': 'nfl',
  'titans': 'nfl', 'tennessee titans': 'nfl',
  'broncos': 'nfl', 'denver broncos': 'nfl',
  'chargers': 'nfl', 'los angeles chargers': 'nfl', 'la chargers': 'nfl',
  'raiders': 'nfl', 'las vegas raiders': 'nfl', 'lv raiders': 'nfl',
  'bears': 'nfl', 'chicago bears': 'nfl',
  'lions': 'nfl', 'detroit lions': 'nfl',
  'packers': 'nfl', 'green bay packers': 'nfl', 'gb packers': 'nfl',
  'vikings': 'nfl', 'minnesota vikings': 'nfl',
  'falcons': 'nfl', 'atlanta falcons': 'nfl',
  'carolina panthers': 'nfl',  // "panthers" alone is ambiguous with Florida Panthers (NHL)
  'saints': 'nfl', 'new orleans saints': 'nfl',
  'buccaneers': 'nfl', 'tampa bay buccaneers': 'nfl', 'bucs': 'nfl',
  '49ers': 'nfl', 'san francisco 49ers': 'nfl', 'niners': 'nfl',
  'seahawks': 'nfl', 'seattle seahawks': 'nfl',
  'rams': 'nfl', 'los angeles rams': 'nfl', 'la rams': 'nfl',
  'commanders': 'nfl', 'washington commanders': 'nfl',
  'arizona cardinals': 'nfl', 'az cardinals': 'nfl',  // Explicit to avoid matching St. Louis Cardinals (MLB)

  // NBA Teams
  'rockets': 'nba', 'houston rockets': 'nba',
  'mavericks': 'nba', 'dallas mavericks': 'nba', 'mavs': 'nba',
  'spurs': 'nba', 'san antonio spurs': 'nba',
  'lakers': 'nba', 'los angeles lakers': 'nba', 'la lakers': 'nba',
  'clippers': 'nba', 'los angeles clippers': 'nba', 'la clippers': 'nba',
  'warriors': 'nba', 'golden state warriors': 'nba', 'gsw': 'nba',
  'suns': 'nba', 'phoenix suns': 'nba',
  'nuggets': 'nba', 'denver nuggets': 'nba',
  'thunder': 'nba', 'oklahoma city thunder': 'nba', 'okc thunder': 'nba',
  'jazz': 'nba', 'utah jazz': 'nba',
  'timberwolves': 'nba', 'minnesota timberwolves': 'nba', 'wolves': 'nba',
  'trail blazers': 'nba', 'portland trail blazers': 'nba', 'blazers': 'nba',
  'kings': 'nba', 'sacramento kings': 'nba',
  'pelicans': 'nba', 'new orleans pelicans': 'nba',
  'grizzlies': 'nba', 'memphis grizzlies': 'nba',
  'celtics': 'nba', 'boston celtics': 'nba',
  'nets': 'nba', 'brooklyn nets': 'nba',
  'knicks': 'nba', 'new york knicks': 'nba',
  '76ers': 'nba', 'philadelphia 76ers': 'nba', 'sixers': 'nba',
  'raptors': 'nba', 'toronto raptors': 'nba',
  'bulls': 'nba', 'chicago bulls': 'nba',
  'cavaliers': 'nba', 'cleveland cavaliers': 'nba', 'cavs': 'nba',
  'pistons': 'nba', 'detroit pistons': 'nba',
  'pacers': 'nba', 'indiana pacers': 'nba',
  'bucks': 'nba', 'milwaukee bucks': 'nba',
  'hawks': 'nba', 'atlanta hawks': 'nba',
  'hornets': 'nba', 'charlotte hornets': 'nba',
  'heat': 'nba', 'miami heat': 'nba',
  'magic': 'nba', 'orlando magic': 'nba',
  'wizards': 'nba', 'washington wizards': 'nba',

  // WNBA Teams
  'aces': 'wnba', 'las vegas aces': 'wnba', 'lv aces': 'wnba',
  'dream': 'wnba', 'atlanta dream': 'wnba',
  'sky': 'wnba', 'chicago sky': 'wnba',
  'sun': 'wnba', 'connecticut sun': 'wnba',
  'wings': 'wnba', 'dallas wings': 'wnba',
  'fever': 'wnba', 'indiana fever': 'wnba',
  'sparks': 'wnba', 'los angeles sparks': 'wnba', 'la sparks': 'wnba',
  'lynx': 'wnba', 'minnesota lynx': 'wnba',
  'liberty': 'wnba', 'new york liberty': 'wnba', 'ny liberty': 'wnba',
  'mercury': 'wnba', 'phoenix mercury': 'wnba',
  'storm': 'wnba', 'seattle storm': 'wnba',
  'mystics': 'wnba', 'washington mystics': 'wnba',
  'valkyries': 'wnba', 'golden state valkyries': 'wnba',

  // NHL Teams
  'stars': 'nhl', 'dallas stars': 'nhl',
  'blackhawks': 'nhl', 'chicago blackhawks': 'nhl',
  'red wings': 'nhl', 'detroit red wings': 'nhl',
  'predators': 'nhl', 'nashville predators': 'nhl', 'preds': 'nhl',
  'blues': 'nhl', 'st louis blues': 'nhl', 'stl blues': 'nhl',
  'wild': 'nhl', 'minnesota wild': 'nhl',
  'avalanche': 'nhl', 'colorado avalanche': 'nhl', 'avs': 'nhl',
  'coyotes': 'nhl', 'arizona coyotes': 'nhl',
  'golden knights': 'nhl', 'vegas golden knights': 'nhl', 'vgk': 'nhl',
  'kraken': 'nhl', 'seattle kraken': 'nhl',
  'sharks': 'nhl', 'san jose sharks': 'nhl',
  'ducks': 'nhl', 'anaheim ducks': 'nhl',
  'flames': 'nhl', 'calgary flames': 'nhl',
  'oilers': 'nhl', 'edmonton oilers': 'nhl',
  'canucks': 'nhl', 'vancouver canucks': 'nhl',
  'bruins': 'nhl', 'boston bruins': 'nhl',
  'sabres': 'nhl', 'buffalo sabres': 'nhl',
  'canadiens': 'nhl', 'montreal canadiens': 'nhl', 'habs': 'nhl',
  'senators': 'nhl', 'ottawa senators': 'nhl', 'sens': 'nhl',
  'maple leafs': 'nhl', 'toronto maple leafs': 'nhl', 'leafs': 'nhl',
  'hurricanes': 'nhl', 'carolina hurricanes': 'nhl', 'canes': 'nhl',
  'blue jackets': 'nhl', 'columbus blue jackets': 'nhl', 'cbj': 'nhl',
  'devils': 'nhl', 'new jersey devils': 'nhl',
  'islanders': 'nhl', 'new york islanders': 'nhl', 'isles': 'nhl',
  'new york rangers': 'nhl', 'ny rangers': 'nhl',  // "rangers" alone is ambiguous with Texas Rangers (MLB)
  'flyers': 'nhl', 'philadelphia flyers': 'nhl',
  'penguins': 'nhl', 'pittsburgh penguins': 'nhl', 'pens': 'nhl',
  'capitals': 'nhl', 'washington capitals': 'nhl', 'caps': 'nhl',
  'lightning': 'nhl', 'tampa bay lightning': 'nhl', 'bolts': 'nhl',
  'panthers (nhl)': 'nhl', 'florida panthers': 'nhl',

  // MLS Teams
  'dynamo': 'mls', 'houston dynamo': 'mls',
  'fc dallas': 'mls', 'dallas fc': 'mls',
  'austin fc': 'mls',
  'lafc': 'mls', 'los angeles fc': 'mls',
  'galaxy': 'mls', 'la galaxy': 'mls', 'los angeles galaxy': 'mls',
  'sounders': 'mls', 'seattle sounders': 'mls',
  'timbers': 'mls', 'portland timbers': 'mls',
  'sporting kc': 'mls', 'sporting kansas city': 'mls',
  'colorado rapids': 'mls', 'rapids': 'mls',
  'real salt lake': 'mls', 'rsl': 'mls',
  'san jose earthquakes': 'mls', 'earthquakes': 'mls',
  'minnesota united': 'mls', 'loons': 'mls',
  'atlanta united': 'mls',
  'nashville sc': 'mls',
  'charlotte fc': 'mls',
  'inter miami': 'mls', 'miami cf': 'mls',
  'orlando city': 'mls',
  'new york red bulls': 'mls', 'red bulls': 'mls',
  'nycfc': 'mls', 'new york city fc': 'mls',
  'new england revolution': 'mls', 'revolution': 'mls',
  'philadelphia union': 'mls', 'union': 'mls',
  'dc united': 'mls',
  'cf montreal': 'mls', 'montreal cf': 'mls',
  'toronto fc': 'mls', 'tfc': 'mls',
  'columbus crew': 'mls', 'crew': 'mls',
  'chicago fire': 'mls', 'fire': 'mls',
  'st louis city': 'mls', 'stl city': 'mls',
};

/**
 * Result of sport detection - may be ambiguous
 */
export interface SportDetectionResult {
  sport?: Sport;
  isAmbiguous: boolean;
  matches: Array<{ teamKey: string; sport: Sport }>;
}

/**
 * Get sport from team name with ambiguity detection
 * Returns all matches so caller can handle ambiguous cases
 */
export function detectSportFromTeam(teamName: string): SportDetectionResult {
  const normalized = teamName.toLowerCase().trim();

  // 1. Check for exact match first
  if (TEAM_SPORT_MAP[normalized]) {
    return {
      sport: TEAM_SPORT_MAP[normalized],
      isAmbiguous: false,
      matches: [{ teamKey: normalized, sport: TEAM_SPORT_MAP[normalized] }],
    };
  }

  // 2. Find ALL partial matches
  const matches: Array<{ teamKey: string; sport: Sport }> = [];
  const seenSports = new Set<Sport>();

  for (const [key, sport] of Object.entries(TEAM_SPORT_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      // Avoid duplicates (e.g., "cardinals" and "st louis cardinals" both map to mlb)
      const alreadyHasSport = matches.some(m => m.sport === sport);
      if (!alreadyHasSport) {
        matches.push({ teamKey: key, sport });
        seenSports.add(sport);
      }
    }
  }

  if (matches.length === 0) {
    return { isAmbiguous: false, matches: [] };
  }

  if (matches.length === 1) {
    return {
      sport: matches[0].sport,
      isAmbiguous: false,
      matches,
    };
  }

  // Multiple sports matched - ambiguous!
  return {
    isAmbiguous: true,
    matches,
  };
}

/**
 * Get sport from team name (simple version for backwards compatibility)
 * Returns undefined if team not found or ambiguous
 */
export function getSportFromTeam(teamName: string): Sport | undefined {
  const result = detectSportFromTeam(teamName);
  if (result.isAmbiguous) {
    return undefined; // Let caller handle ambiguity
  }
  return result.sport;
}

/**
 * Get the spreadsheet ID for a sport
 */
function getSpreadsheetIdForSport(sport: Sport): string | undefined {
  return configCompat.accountSheets[sport];
}

/**
 * Log configured spreadsheet IDs at startup
 * Call this from server start to verify configuration
 */
export function logSheetsConfiguration(): void {
  console.log('[Sheets] === Account Sheets Configuration ===');
  const sports: Sport[] = ['mlb', 'nfl', 'nba', 'nhl', 'mls', 'ncaa', 'other'];
  for (const sport of sports) {
    const id = configCompat.accountSheets[sport];
    if (id) {
      console.log(`[Sheets]   ${sport.toUpperCase()}: ${id}`);
    } else {
      console.log(`[Sheets]   ${sport.toUpperCase()}: NOT CONFIGURED`);
    }
  }
  console.log('[Sheets] =====================================');
}

export interface AccountInfo {
  /** Raw row data from the sheet */
  rowData: string[];
  /** Row number in the sheet (1-indexed) */
  rowNumber: number;
}

export interface AccountLookupResult {
  success: boolean;
  sport: Sport;
  teamName: string;
  sheetName: string;
  accounts: AccountInfo[];
  headers: string[];
  error?: string;
}

/**
 * Find a sheet by partial name match
 * e.g., "astros" should match "Houston Astros" sheet
 */
async function findSheetByName(
  spreadsheetId: string,
  searchName: string
): Promise<{ sheetName: string; sheetId: number } | null> {
  console.log(`[Sheets] findSheetByName: Fetching sheet list from spreadsheet ${spreadsheetId.substring(0, 10)}...`);

  const response = await coreApiGoogle.sheets.getMetadata(spreadsheetId);

  const sheetList = response.sheets || [];
  const allSheetNames = sheetList.map(s => s.title || 'unnamed').join(', ');
  console.log(`[Sheets] findSheetByName: Found ${sheetList.length} sheets: [${allSheetNames}]`);

  const normalized = searchName.toLowerCase().trim();
  console.log(`[Sheets] findSheetByName: Searching for "${normalized}"...`);

  // First try exact match
  for (const sheet of sheetList) {
    const title = sheet.title || '';
    if (title.toLowerCase() === normalized) {
      console.log(`[Sheets] findSheetByName: EXACT MATCH found: "${title}"`);
      return { sheetName: title, sheetId: sheet.sheetId || 0 };
    }
  }

  // Then try partial match (search term in sheet name or vice versa)
  for (const sheet of sheetList) {
    const title = sheet.title || '';
    const titleLower = title.toLowerCase();
    if (titleLower.includes(normalized) || normalized.includes(titleLower)) {
      console.log(`[Sheets] findSheetByName: PARTIAL MATCH found: "${title}" (contains "${normalized}")`);
      return { sheetName: title, sheetId: sheet.sheetId || 0 };
    }
  }

  // Try word-by-word matching (e.g., "astros" matches "Houston Astros")
  // Require minimum 4 chars and whole-word match to avoid false positives
  // like "seat" matching "Seattle"
  const searchWords = normalized.split(/\s+/).filter(w => w.length >= 4);
  for (const sheet of sheetList) {
    const title = sheet.title || '';
    const titleWords = title.toLowerCase().split(/\s+/);
    if (searchWords.some(word => titleWords.includes(word))) {
      console.log(`[Sheets] findSheetByName: WORD MATCH found: "${title}" (contains word from "${normalized}")`);
      return { sheetName: title, sheetId: sheet.sheetId || 0 };
    }
  }

  console.log(`[Sheets] findSheetByName: NO MATCH found for "${searchName}"`);
  return null;
}

/**
 * Lookup account information for a team
 *
 * @param teamName - Team name (e.g., "Astros", "Houston Astros", "astros")
 * @param sportOverride - Optional sport override (skips auto-detection)
 * @returns Account lookup result with all matching rows
 */
export async function lookupTeamAccounts(
  teamName: string,
  sportOverride?: Sport,
  spreadsheetIdOverride?: string
): Promise<AccountLookupResult> {
  console.log(`[Sheets] lookupTeamAccounts called with teamName="${teamName}", sportOverride=${sportOverride || 'none'}, sheetIdOverride=${spreadsheetIdOverride ? spreadsheetIdOverride.substring(0, 10) + '...' : 'none'}`);

  let spreadsheetId: string | undefined;
  let sport: Sport | undefined;

  if (spreadsheetIdOverride) {
    // Manual override: skip sport detection and env var lookup
    spreadsheetId = spreadsheetIdOverride;
    sport = sportOverride || getSportFromTeam(teamName) || 'other';
    console.log(`[Sheets] Using spreadsheet ID override: ${spreadsheetId.substring(0, 10)}...`);
  } else {
    // Normal path: detect sport → get spreadsheet ID from config
    sport = sportOverride || getSportFromTeam(teamName);
    console.log(`[Sheets] Sport detection: "${teamName}" → ${sport || 'NOT FOUND'}`);

    if (!sport) {
      console.error(`[Sheets] FAILED: Could not determine sport for team "${teamName}"`);
      return {
        success: false,
        sport: 'other',
        teamName,
        sheetName: '',
        accounts: [],
        headers: [],
        error: `Could not determine sport for team: ${teamName}`,
      };
    }

    spreadsheetId = getSpreadsheetIdForSport(sport);
    console.log(`[Sheets] Spreadsheet lookup: ${sport.toUpperCase()} → ${spreadsheetId ? `ID: ${spreadsheetId.substring(0, 10)}...` : 'NOT CONFIGURED'}`);

    if (!spreadsheetId) {
      console.error(`[Sheets] FAILED: No spreadsheet ID configured for sport ${sport.toUpperCase()}`);
      return {
        success: false,
        sport,
        teamName,
        sheetName: '',
        accounts: [],
        headers: [],
        error: `No spreadsheet configured for sport: ${sport.toUpperCase()}. Set SHEETS_${sport.toUpperCase()}_ID env var.`,
      };
    }
  }

  try {
    console.log(`[Sheets] Connecting to core-api for Google Sheets...`);

    // Find the matching sheet
    console.log(`[Sheets] Searching for sheet matching "${teamName}" in spreadsheet ${spreadsheetId.substring(0, 10)}...`);
    const sheetMatch = await findSheetByName(spreadsheetId, teamName);
    if (!sheetMatch) {
      console.error(`[Sheets] FAILED: No sheet found matching "${teamName}" in ${sport.toUpperCase()} workbook`);
      return {
        success: false,
        sport,
        teamName,
        sheetName: '',
        accounts: [],
        headers: [],
        error: `No sheet found matching "${teamName}" in ${sport.toUpperCase()} workbook`,
      };
    }

    console.log(`[Sheets] Found matching sheet: "${sheetMatch.sheetName}" (sheetId: ${sheetMatch.sheetId})`);

    // Read all data from the sheet via core-api
    console.log(`[Sheets] Reading data from sheet "${sheetMatch.sheetName}"...`);
    const rows = await coreApiGoogle.sheets.getValues(
      spreadsheetId,
      `'${sheetMatch.sheetName}'`  // Quotes handle special chars in sheet names
    );

    console.log(`[Sheets] Retrieved ${rows.length} rows from sheet`);

    if (rows.length === 0) {
      console.error(`[Sheets] FAILED: Sheet "${sheetMatch.sheetName}" is empty`);
      return {
        success: false,
        sport,
        teamName,
        sheetName: sheetMatch.sheetName,
        accounts: [],
        headers: [],
        error: `Sheet "${sheetMatch.sheetName}" is empty`,
      };
    }

    // First row is headers, rest are data
    const headers = rows[0] as string[];
    const accounts: AccountInfo[] = rows.slice(1).map((row, index) => ({
      rowData: row as string[],
      rowNumber: index + 2, // +2 because 1-indexed and skipping header
    }));

    console.log(`[Sheets] SUCCESS: Found ${accounts.length} accounts for ${teamName} (${sheetMatch.sheetName})`);
    console.log(`[Sheets] Headers: ${headers.join(', ')}`);

    return {
      success: true,
      sport,
      teamName,
      sheetName: sheetMatch.sheetName,
      accounts,
      headers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Extract more details from Google API errors
    const errorDetails = error instanceof Error && 'response' in error
      ? JSON.stringify((error as { response?: { data?: unknown } }).response?.data || {})
      : '';
    console.error(`[Sheets] EXCEPTION during lookup for "${teamName}":`);
    console.error(`[Sheets]   Sport: ${sport}`);
    console.error(`[Sheets]   Spreadsheet ID: ${spreadsheetId}`);
    console.error(`[Sheets]   Error message: ${message}`);
    if (errorDetails) {
      console.error(`[Sheets]   API response: ${errorDetails}`);
    }
    return {
      success: false,
      sport,
      teamName,
      sheetName: '',
      accounts: [],
      headers: [],
      error: `Lookup failed: ${message}`,
    };
  }
}

/**
 * Format account info as a readable string
 * Useful for Slack messages or logs
 */
export function formatAccountsForDisplay(result: AccountLookupResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  if (result.accounts.length === 0) {
    return `No accounts found for ${result.teamName}`;
  }

  const lines: string[] = [
    `*${result.sheetName}* (${result.sport.toUpperCase()}) - ${result.accounts.length} account(s)`,
    '',
  ];

  // Build a formatted table
  for (const account of result.accounts) {
    const details = result.headers
      .map((header, i) => `${header}: ${account.rowData[i] || 'N/A'}`)
      .join(' | ');
    lines.push(`• ${details}`);
  }

  return lines.join('\n');
}


// ============================================================================
// SCAN ACCOUNT ENRICHMENT
// Batch lookup account info for /scan recipients from sport-specific sheets
// ============================================================================

/**
 * Parsed seat location with numeric data for adjacency detection
 */
export interface ParsedSeatLocation {
  section: string;
  row: string;
  lowSeat: number;
  highSeat: number;
  qty: string;          // e.g., "4"
  seasonTotal: string;  // e.g., "$5,000"
  display: string;      // e.g., "Sec 100 Row 5 Seats 1-4 | Qty: 4 | Total: $5,000"
}

/**
 * Account info for a single recipient (used by /scan)
 */
export interface ScanAccountInfo {
  name: string;
  seats: string;        // Newline-separated: "Sec 100 Row 5 Seats 1-4\nSec 200 Row 10 Seats 1-2"
  seatLocations: ParsedSeatLocation[];  // Structured data for adjacency detection
  connecting: string;   // Adjacent seat holders: "email@example.com (Sec 100 Row 5 Seats 5-8)"
  last4: string;        // Last 4 digits of card on file
  exp: string;          // Card expiration date
  cvv: string;          // Card CVV/CVC
  billingAddress: string; // Billing/mailing address
  status: string;       // Account status (e.g. "Active", "Pending Renewal")
}

export interface ScanAccountLookupResult {
  matched: Map<string, ScanAccountInfo>;       // email → account info for scanned recipients
  allAccounts: Map<string, ScanAccountInfo>;   // email → account info for ALL accounts in team sheet
}

/**
 * Batch lookup account info for multiple recipient emails against a team's account sheet.
 * Fetches the team sheet ONCE and matches all emails in-memory.
 * Returns both matched accounts and ALL accounts (for "no appointment" section).
 *
 * @param teamName - Team name (e.g., "Miami Dolphins")
 * @param emails - Array of recipient emails to look up
 * @returns matched map + allAccounts map
 */
export async function batchLookupAccountsForScan(
  teamName: string,
  emails: string[],
  spreadsheetIdOverride?: string
): Promise<ScanAccountLookupResult> {
  const matched = new Map<string, ScanAccountInfo>();
  const allAccounts = new Map<string, ScanAccountInfo>();

  console.log(`[Sheets] Batch account lookup for "${teamName}" (${emails.length} emails)${spreadsheetIdOverride ? `, sheetId override: ${spreadsheetIdOverride.substring(0, 10)}...` : ''}...`);

  // Fetch all accounts for this team (one API call)
  let teamResult: AccountLookupResult;
  try {
    teamResult = await lookupTeamAccounts(teamName, undefined, spreadsheetIdOverride);
  } catch (error) {
    console.error(`[Sheets] Failed to lookup team accounts for "${teamName}":`, error instanceof Error ? error.message : error);
    return { matched, allAccounts };
  }

  if (!teamResult.success) {
    console.log(`[Sheets] Account lookup failed for "${teamName}": ${teamResult.error}`);
    return { matched, allAccounts };
  }

  const { headers, accounts } = teamResult;
  console.log(`[Sheets] Found ${accounts.length} total accounts for "${teamResult.sheetName}"`);

  // Find the email column index
  const emailIdx = findColumnIndex(headers, 'email', 'e-mail', 'email address');
  if (emailIdx === -1) {
    console.log(`[Sheets] No email column found in sheet headers: ${headers.join(', ')}`);
    return { matched, allAccounts };
  }

  // Build a lookup map: lowercase email → array of matching rows
  const emailToRows = new Map<string, AccountInfo[]>();
  for (const account of accounts) {
    const accEmail = account.rowData[emailIdx]?.toLowerCase().trim() || '';
    if (!accEmail) continue;
    if (!emailToRows.has(accEmail)) {
      emailToRows.set(accEmail, []);
    }
    emailToRows.get(accEmail)!.push(account);
  }

  // Helper: parse seat locations from account rows
  function parseSeatLocations(rows: AccountInfo[]): ParsedSeatLocation[] {
    const locations: ParsedSeatLocation[] = [];
    for (const acc of rows) {
      const section = getColumnValue(acc.rowData, headers, 'section', 'sec');
      const rowVal = getColumnValue(acc.rowData, headers, 'row');
      const lowSeatStr = getColumnValue(acc.rowData, headers, 'low seat', 'seat low', 'first seat', 'seat from', 'low');
      const highSeatStr = getColumnValue(acc.rowData, headers, 'high seat', 'seat high', 'last seat', 'seat to', 'high');
      const seatsStr = getColumnValue(acc.rowData, headers, 'seats', 'seat', 'seat numbers');
      const qty = getColumnValue(acc.rowData, headers, 'qty', 'quantity', 'num seats', '# seats', 'count');
      const seasonTotal = getColumnValue(acc.rowData, headers, 'season total', 'total', 'season price', 'price', 'amount', 'season amt');

      const parts: string[] = [];
      if (section) parts.push(`Sec ${section}`);
      if (rowVal) parts.push(`Row ${rowVal}`);

      let lowSeat = 0;
      let highSeat = 0;

      if (lowSeatStr && highSeatStr) {
        lowSeat = parseInt(lowSeatStr, 10) || 0;
        highSeat = parseInt(highSeatStr, 10) || 0;
        parts.push(`Seats ${lowSeatStr}-${highSeatStr}`);
      } else if (lowSeatStr) {
        lowSeat = parseInt(lowSeatStr, 10) || 0;
        highSeat = lowSeat;
        parts.push(`Seat ${lowSeatStr}`);
      } else if (seatsStr) {
        // Try to parse "1-4" format
        const range = seatsStr.match(/(\d+)\s*-\s*(\d+)/);
        if (range) {
          lowSeat = parseInt(range[1], 10) || 0;
          highSeat = parseInt(range[2], 10) || 0;
        }
        parts.push(`Seats ${seatsStr}`);
      }

      if (qty) parts.push(`Qty: ${qty}`);
      if (seasonTotal) parts.push(`Total: ${seasonTotal}`);

      if (parts.length > 0) {
        locations.push({
          section: section.toLowerCase().trim(),
          row: rowVal.toLowerCase().trim(),
          lowSeat,
          highSeat,
          qty,
          seasonTotal,
          display: parts.join(' | '),
        });
      }
    }
    return locations;
  }

  // Helper: build ScanAccountInfo for an email with adjacency detection
  function buildAccountInfo(email: string, rows: AccountInfo[], allAccountsByEmail: Map<string, { seatLocations: ParsedSeatLocation[] }>): ScanAccountInfo {
    const firstRow = rows[0].rowData;
    const name = getColumnValue(firstRow, headers, 'name', 'account name', 'customer name', 'full name');
    const last4 = getColumnValue(firstRow, headers, 'last 4', 'last4', 'card last 4', 'cc last 4');
    const exp = getColumnValue(firstRow, headers, 'exp', 'expiration', 'exp date', 'expiry');
    const cvv = getColumnValue(firstRow, headers, 'cvc', 'cvv', 'security code', 'cv2');
    const billingAddress = getColumnValue(firstRow, headers, 'address', 'street address', 'mailing address', 'billing address');
    const status = getColumnValue(firstRow, headers, 'status', 'account status');
    const seatLocations = parseSeatLocations(rows);

    // Find connecting seats
    const connectingEntries: string[] = [];
    for (const loc of seatLocations) {
      if (!loc.section || !loc.row || (!loc.lowSeat && !loc.highSeat)) continue;
      for (const [otherEmail, otherData] of allAccountsByEmail.entries()) {
        if (otherEmail === email) continue;
        for (const otherLoc of otherData.seatLocations) {
          if (otherLoc.section !== loc.section || otherLoc.row !== loc.row) continue;
          const isAdjacent =
            (otherLoc.highSeat > 0 && loc.lowSeat > 0 && otherLoc.highSeat + 1 === loc.lowSeat) ||
            (loc.highSeat > 0 && otherLoc.lowSeat > 0 && loc.highSeat + 1 === otherLoc.lowSeat);
          if (isAdjacent) {
            const entry = `${otherEmail} (${otherLoc.display})`;
            if (!connectingEntries.includes(entry)) connectingEntries.push(entry);
          }
        }
      }
    }

    return {
      name,
      seats: seatLocations.map(l => l.display).join('\n'),
      seatLocations,
      connecting: connectingEntries.join('\n'),
      last4,
      exp,
      cvv,
      billingAddress,
      status,
    };
  }

  // First pass: parse seat locations for ALL accounts (needed for adjacency)
  const allSeatsByEmail = new Map<string, { seatLocations: ParsedSeatLocation[] }>();
  for (const [email, rows] of emailToRows.entries()) {
    allSeatsByEmail.set(email, { seatLocations: parseSeatLocations(rows) });
  }

  // Build account info for ALL accounts
  for (const [email, rows] of emailToRows.entries()) {
    allAccounts.set(email, buildAccountInfo(email, rows, allSeatsByEmail));
  }

  // Match recipient emails
  const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));
  let matchCount = 0;
  for (const email of emailSet) {
    const info = allAccounts.get(email);
    if (info) {
      matched.set(email, info);
      matchCount++;
    }
  }

  console.log(`[Sheets] Matched ${matchCount}/${emailSet.size} recipient emails to accounts, ${allAccounts.size} total accounts`);
  return { matched, allAccounts };
}

// ============================================================================
// BACKFILL "NO APPOINTMENT" SECTION ON EXISTING SHEET
// ============================================================================

/**
 * Extract spreadsheet ID from a Google Sheets URL
 */
function extractSpreadsheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Retroactively add a "No Appointment" section to an existing scan sheet.
 * Reads the sheet to find which emails are already present, looks up all team
 * accounts, then appends rows for accounts not already on the sheet
 * (excluding Not Active, Revoked, Deposit statuses).
 */
export async function backfillNoAppointmentSection(
  sheetUrl: string,
  teamName: string
): Promise<{ addedCount: number }> {
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) {
    throw new Error('Invalid sheet URL — could not extract spreadsheet ID');
  }

  // 1. Read existing sheet to find emails already present
  const existingRows = await coreApiGoogle.sheets.getValues(spreadsheetId, 'Recipients!A1:Z');
  if (!existingRows || existingRows.length === 0) {
    throw new Error('Sheet is empty or could not be read');
  }

  const headerRow = existingRows[0] as string[];
  const emailColIdx = headerRow.findIndex(h => String(h).toLowerCase().trim() === 'email');
  if (emailColIdx < 0) {
    throw new Error('Could not find "Email" column in sheet header');
  }

  // Determine if this is a full-format sheet (with account info columns)
  const hasAccountInfo = headerRow.some(h => String(h).toLowerCase().trim() === 'name');

  // Collect all emails already on the sheet
  const existingEmails = new Set<string>();
  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i] as string[];
    const email = (row[emailColIdx] || '').toLowerCase().trim();
    if (email && email.includes('@')) {
      existingEmails.add(email);
    }
  }
  console.log(`[Sheets Backfill] Found ${existingEmails.size} existing emails on sheet`);

  // 2. Look up all team accounts
  const lookupResult = await batchLookupAccountsForScan(teamName, []);
  const { allAccounts } = lookupResult;
  console.log(`[Sheets Backfill] Team "${teamName}" has ${allAccounts.size} total accounts`);

  // 3. Filter to accounts not already on sheet, excluding bad statuses
  const excludedStatuses = ['not active', 'revoked', 'deposit'];
  const noAppointmentRows: (string | number)[][] = [];

  for (const [email, account] of allAccounts.entries()) {
    if (existingEmails.has(email)) continue;
    const statusLower = (account.status || '').toLowerCase().trim();
    if (excludedStatuses.includes(statusLower)) continue;

    if (hasAccountInfo) {
      if (account.seatLocations.length > 0) {
        for (const loc of account.seatLocations) {
          const lowSeatStr = loc.lowSeat ? String(loc.lowSeat) : '';
          const highSeatStr = loc.highSeat ? String(loc.highSeat) : '';
          noAppointmentRows.push(['', '', email, account.name, loc.section, loc.row, lowSeatStr, highSeatStr, loc.qty, '', loc.seasonTotal || '', account.last4, account.exp, account.cvv, account.billingAddress, account.status || '', '']);
        }
      } else {
        noAppointmentRows.push(['', '', email, account.name, '', '', '', '', '', '', '', account.last4, account.exp, account.cvv, account.billingAddress, account.status || '', '']);
      }
    } else {
      noAppointmentRows.push(['', '', email, account.status || '', '']);
    }
  }

  if (noAppointmentRows.length === 0) {
    console.log('[Sheets Backfill] All team accounts are already on the sheet or excluded');
    return { addedCount: 0 };
  }

  // 4. Append separator + header + rows
  const columnCount = headerRow.length;
  const separatorRow = new Array(columnCount).fill('');
  const sectionHeaderRow = new Array(columnCount).fill('');
  sectionHeaderRow[0] = `NO APPOINTMENT (${noAppointmentRows.length})`;

  const appendRows = [separatorRow, sectionHeaderRow, ...noAppointmentRows];

  await coreApiGoogle.sheets.appendValues(spreadsheetId, {
    range: 'Recipients!A1',
    values: appendRows,
  });

  console.log(`[Sheets Backfill] Appended ${noAppointmentRows.length} "No Appointment" rows to sheet`);
  return { addedCount: noAppointmentRows.length };
}

// ============================================================================
// ISSUE CALL ACCOUNT LOOKUP
// Lookup specific account by team + email for /issuecall command
// ============================================================================

/**
 * Find column index by header name (case-insensitive, partial match)
 */
function findColumnIndex(headers: string[], ...possibleNames: string[]): number {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  for (const name of possibleNames) {
    const lowerName = name.toLowerCase();
    // Exact match first
    const exactIdx = lowerHeaders.indexOf(lowerName);
    if (exactIdx !== -1) return exactIdx;

    // Partial match
    const partialIdx = lowerHeaders.findIndex(h => h.includes(lowerName) || lowerName.includes(h));
    if (partialIdx !== -1) return partialIdx;
  }

  return -1;
}

/**
 * Get value from row by column name
 */
function getColumnValue(row: string[], headers: string[], ...possibleNames: string[]): string {
  const idx = findColumnIndex(headers, ...possibleNames);
  if (idx === -1 || idx >= row.length) return '';
  return row[idx]?.trim() || '';
}

export interface IssueCallAccountResult {
  success: boolean;
  team: string;
  name: string;
  email: string;
  phone: string;
  seats: string;  // Formatted: "Sec 100 Row 5 Seats 1-4, Sec 200 Row 10 Seats 1-2"
  address: string;
  cardInfo: string;  // "Last 4: XXXX Exp: XX/XX CVC: XXX"
  error?: string;
  // Ambiguity handling
  isAmbiguous?: boolean;
  ambiguousMatches?: Array<{ teamKey: string; sport: Sport }>;
}

/**
 * Lookup account by team + email for /issuecall
 * Returns formatted account info with concatenated seats if multiple rows
 * Returns isAmbiguous=true if team name matches multiple sports
 */
export async function lookupAccountForIssueCall(
  teamName: string,
  email: string
): Promise<IssueCallAccountResult> {
  // Check for ambiguous team name first
  const sportDetection = detectSportFromTeam(teamName);

  if (sportDetection.isAmbiguous) {
    return {
      success: false,
      team: teamName,
      name: '',
      email,
      phone: '',
      seats: '',
      address: '',
      cardInfo: '',
      isAmbiguous: true,
      ambiguousMatches: sportDetection.matches,
      error: `Ambiguous team name "${teamName}" - matches multiple sports`,
    };
  }

  // First get all accounts for the team
  const teamResult = await lookupTeamAccounts(teamName);

  if (!teamResult.success) {
    return {
      success: false,
      team: teamName,
      name: '',
      email,
      phone: '',
      seats: '',
      address: '',
      cardInfo: '',
      error: teamResult.error,
    };
  }

  // Find email column and filter accounts
  const emailIdx = findColumnIndex(teamResult.headers, 'email', 'e-mail', 'email address');
  if (emailIdx === -1) {
    return {
      success: false,
      team: teamName,
      name: '',
      email,
      phone: '',
      seats: '',
      address: '',
      cardInfo: '',
      error: 'Email column not found in sheet',
    };
  }

  // Filter to matching email (case-insensitive)
  const lowerEmail = email.toLowerCase().trim();
  const matchingAccounts = teamResult.accounts.filter(acc => {
    const accEmail = acc.rowData[emailIdx]?.toLowerCase().trim() || '';
    return accEmail === lowerEmail;
  });

  if (matchingAccounts.length === 0) {
    return {
      success: false,
      team: teamResult.sheetName,
      name: '',
      email,
      phone: '',
      seats: '',
      address: '',
      cardInfo: '',
      error: `No account found with email: ${email}`,
    };
  }

  // Get data from first row (name, phone, address, card info are same across rows)
  const firstRow = matchingAccounts[0].rowData;
  const headers = teamResult.headers;

  const name = getColumnValue(firstRow, headers, 'name', 'account name', 'customer name', 'full name');
  const phone = getColumnValue(firstRow, headers, 'phone', 'phone number', 'cell', 'mobile');
  const address = getColumnValue(firstRow, headers, 'address', 'street address', 'mailing address');

  // Card info - try various column names
  const last4 = getColumnValue(firstRow, headers, 'last 4', 'last4', 'card last 4', 'cc last 4');
  const exp = getColumnValue(firstRow, headers, 'exp', 'expiration', 'exp date', 'expiry');
  const cvc = getColumnValue(firstRow, headers, 'cvc', 'cvv', 'security code', 'cv2');

  // Build card info string
  const cardParts: string[] = [];
  if (last4) cardParts.push(`Last 4: ${last4}`);
  if (exp) cardParts.push(`Exp: ${exp}`);
  if (cvc) cardParts.push(`CVC: ${cvc}`);
  const cardInfo = cardParts.join(' | ');

  // Build seats string from all matching rows
  const seatStrings: string[] = [];
  for (const acc of matchingAccounts) {
    const section = getColumnValue(acc.rowData, headers, 'section', 'sec');
    const row = getColumnValue(acc.rowData, headers, 'row');
    const lowSeat = getColumnValue(acc.rowData, headers, 'low seat', 'seat low', 'first seat', 'seat from', 'low');
    const highSeat = getColumnValue(acc.rowData, headers, 'high seat', 'seat high', 'last seat', 'seat to', 'high');
    const seats = getColumnValue(acc.rowData, headers, 'seats', 'seat', 'seat numbers');

    // Build seat string for this row
    const parts: string[] = [];
    if (section) parts.push(`Sec ${section}`);
    if (row) parts.push(`Row ${row}`);

    // Handle seats - either low-high range or single seats column
    if (lowSeat && highSeat) {
      parts.push(`Seats ${lowSeat}-${highSeat}`);
    } else if (lowSeat) {
      parts.push(`Seat ${lowSeat}`);
    } else if (seats) {
      parts.push(`Seats ${seats}`);
    }

    if (parts.length > 0) {
      seatStrings.push(parts.join(' '));
    }
  }

  const seatsFormatted = seatStrings.length > 1
    ? '\n  • ' + seatStrings.join('\n  • ')
    : seatStrings[0] || '';

  console.log(`Found ${matchingAccounts.length} seat location(s) for ${email} (${teamResult.sheetName})`);

  return {
    success: true,
    team: teamResult.sheetName,
    name,
    email,
    phone,
    seats: seatsFormatted,
    address,
    cardInfo,
  };
}

/**
 * Format issue call account for Slack display
 */
export function formatIssueCallAccount(result: IssueCallAccountResult): string {
  if (!result.success) {
    return `❌ ${result.error}`;
  }

  const lines: string[] = [
    `*Team:* ${result.team}`,
    `*Name:* ${result.name || 'N/A'}`,
    `*Email:* ${result.email}`,
    `*Phone:* ${result.phone || 'N/A'}`,
    `*Seats:* ${result.seats || 'N/A'}`,
    `*Address:* ${result.address || 'N/A'}`,
    `*Card:* ${result.cardInfo || 'N/A'}`,
  ];

  return lines.join('\n');
}
