/**
 * Google Sheets Service
 *
 * Creates spreadsheets for presale/relocation tracking
 * with recipient emails and appointment times
 */

import { google } from 'googleapis';
import { config } from '../config/environment.js';
import type { RecipientWithAppointment } from './gmail.js';

let sheetsClient: ReturnType<typeof google.sheets> | null = null;
let driveClient: ReturnType<typeof google.drive> | null = null;

/**
 * Initialize Google Sheets API client with service account
 */
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const serviceAccountKey = config.google.serviceAccountKey;
  if (!serviceAccountKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured');
  }

  const credentials = JSON.parse(serviceAccountKey);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient as any });
  driveClient = google.drive({ version: 'v3', auth: authClient as any });

  return sheetsClient;
}

async function getDriveClient() {
  if (!driveClient) {
    await getSheetsClient(); // This initializes both
  }
  return driveClient!;
}

export interface SheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
}

/**
 * Create a Google Sheet with recipient appointment data
 */
export async function createRecipientSheet(
  title: string,
  recipients: RecipientWithAppointment[]
): Promise<SheetResult> {
  const sheets = await getSheetsClient();

  // Create the spreadsheet
  const createResponse = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: title,
      },
      sheets: [
        {
          properties: {
            title: 'Recipients',
            gridProperties: {
              frozenRowCount: 1, // Freeze header row
            },
          },
        },
      ],
    },
  });

  const spreadsheetId = createResponse.data.spreadsheetId!;
  const spreadsheetUrl = createResponse.data.spreadsheetUrl!;

  // Build the data rows
  const headerRow = ['Email', 'Date', 'Time', 'Status', 'Notes'];
  const dataRows = recipients.map(r => [
    r.email,
    r.appointmentDate || '',
    r.appointmentTime || '',
    '', // Status column for manual tracking
    '', // Notes column
  ]);

  // Add data to the sheet
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Recipients!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [headerRow, ...dataRows],
    },
  });

  // Format the header row (bold, background color)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: 0,
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
        // Auto-resize columns
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: 0,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 5,
            },
          },
        },
      ],
    },
  });

  // Make the sheet accessible to anyone with the link
  const drive = await getDriveClient();
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'writer', // Anyone with link can edit
      type: 'anyone',
    },
  });

  console.log(`Created Google Sheet: ${spreadsheetUrl}`);

  return {
    spreadsheetId,
    spreadsheetUrl,
    title,
  };
}

/**
 * Check if we should create a sheet (presale/relocation keywords)
 */
export function shouldCreateSheet(subject: string): boolean {
  const keywords = ['presale', 'pre-sale', 'relocation', 'selection'];
  const lowerSubject = subject.toLowerCase();
  return keywords.some(keyword => lowerSubject.includes(keyword));
}


// ============================================================================
// ACCOUNT LOOKUP FEATURE
// Lookup account info from sport-specific Google Sheets workbooks
// ============================================================================

export type Sport = 'mlb' | 'nfl' | 'nba' | 'nhl' | 'mls' | 'ncaa' | 'other';

/**
 * Team to sport mapping
 * Keys are lowercase, can be partial names (e.g., "astros" or "houston astros")
 */
const TEAM_SPORT_MAP: Record<string, Sport> = {
  // MLB Teams
  'astros': 'mlb', 'houston astros': 'mlb',
  'rangers': 'mlb', 'texas rangers': 'mlb',
  'yankees': 'mlb', 'new york yankees': 'mlb',
  'mets': 'mlb', 'new york mets': 'mlb',
  'dodgers': 'mlb', 'los angeles dodgers': 'mlb', 'la dodgers': 'mlb',
  'angels': 'mlb', 'los angeles angels': 'mlb', 'la angels': 'mlb',
  'red sox': 'mlb', 'boston red sox': 'mlb',
  'cubs': 'mlb', 'chicago cubs': 'mlb',
  'white sox': 'mlb', 'chicago white sox': 'mlb',
  'braves': 'mlb', 'atlanta braves': 'mlb',
  'phillies': 'mlb', 'philadelphia phillies': 'mlb',
  'giants': 'mlb', 'san francisco giants': 'mlb', 'sf giants': 'mlb',
  'cardinals': 'mlb', 'st louis cardinals': 'mlb', 'stl cardinals': 'mlb',
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
  'panthers': 'nfl', 'carolina panthers': 'nfl',
  'saints': 'nfl', 'new orleans saints': 'nfl',
  'buccaneers': 'nfl', 'tampa bay buccaneers': 'nfl', 'bucs': 'nfl',
  '49ers': 'nfl', 'san francisco 49ers': 'nfl', 'niners': 'nfl',
  'seahawks': 'nfl', 'seattle seahawks': 'nfl',
  'rams': 'nfl', 'los angeles rams': 'nfl', 'la rams': 'nfl',
  'commanders': 'nfl', 'washington commanders': 'nfl',

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
 * Get sport from team name
 * Returns undefined if team not found
 */
export function getSportFromTeam(teamName: string): Sport | undefined {
  const normalized = teamName.toLowerCase().trim();

  // Direct match
  if (TEAM_SPORT_MAP[normalized]) {
    return TEAM_SPORT_MAP[normalized];
  }

  // Partial match - check if any key contains or is contained in the input
  for (const [key, sport] of Object.entries(TEAM_SPORT_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return sport;
    }
  }

  return undefined;
}

/**
 * Get the spreadsheet ID for a sport
 */
function getSpreadsheetIdForSport(sport: Sport): string | undefined {
  return config.accountSheets[sport];
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
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });

  const sheetList = response.data.sheets || [];
  const normalized = searchName.toLowerCase().trim();

  // First try exact match
  for (const sheet of sheetList) {
    const title = sheet.properties?.title || '';
    if (title.toLowerCase() === normalized) {
      return { sheetName: title, sheetId: sheet.properties?.sheetId || 0 };
    }
  }

  // Then try partial match (search term in sheet name or vice versa)
  for (const sheet of sheetList) {
    const title = sheet.properties?.title || '';
    const titleLower = title.toLowerCase();
    if (titleLower.includes(normalized) || normalized.includes(titleLower)) {
      return { sheetName: title, sheetId: sheet.properties?.sheetId || 0 };
    }
  }

  // Try word-by-word matching (e.g., "astros" matches "Houston Astros")
  const searchWords = normalized.split(/\s+/);
  for (const sheet of sheetList) {
    const title = sheet.properties?.title || '';
    const titleLower = title.toLowerCase();
    if (searchWords.some(word => titleLower.includes(word))) {
      return { sheetName: title, sheetId: sheet.properties?.sheetId || 0 };
    }
  }

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
  sportOverride?: Sport
): Promise<AccountLookupResult> {
  // Determine sport
  const sport = sportOverride || getSportFromTeam(teamName);
  if (!sport) {
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

  // Get spreadsheet ID
  const spreadsheetId = getSpreadsheetIdForSport(sport);
  if (!spreadsheetId) {
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

  try {
    const sheets = await getSheetsClient();

    // Find the matching sheet
    const sheetMatch = await findSheetByName(spreadsheetId, teamName);
    if (!sheetMatch) {
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

    // Read all data from the sheet
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetMatch.sheetName}'`,  // Quotes handle special chars in sheet names
    });

    const rows = dataResponse.data.values || [];
    if (rows.length === 0) {
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

    console.log(`Found ${accounts.length} accounts for ${teamName} (${sheetMatch.sheetName})`);

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
    console.error(`Account lookup failed for ${teamName}:`, message);
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
