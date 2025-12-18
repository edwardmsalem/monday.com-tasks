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
