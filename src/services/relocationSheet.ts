/**
 * "One sheet per team, keep adding" (Eddie, 2026-10-07): put newly found
 * appointments onto a campaign's existing scan sheet instead of making a new one.
 *
 * The scan sheet (createScanSheet) is one tab: a header row, the accounts with
 * appointments, then a "NO APPOINTMENT (n)" section with the team's remaining
 * accounts and their seats and card details. A newly scanned account usually
 * already has a row there, so only its Date and Time cells are written. An
 * account the sheet does not have gets a new row at the bottom with date, time
 * and email. No other cell is rewritten, so values such as a card's last 4
 * with a leading zero are never re-entered.
 */

import { google as coreApiGoogle } from './coreApi.js';
import { isoToSheetDate, isoToSheetTime } from './sheets.js';

export interface NewAppointment { email: string; rawDateTime: string }

const colLetter = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Returns how many rows got a date and time (filled in or added). */
export async function addAppointmentsToScanSheet(spreadsheetId: string, appts: NewAppointment[]): Promise<number> {
  if (appts.length === 0) return 0;
  const grid = (await coreApiGoogle.sheets.getValues(spreadsheetId, 'A1:AZ5000')) as unknown[][];
  if (!grid.length) throw new Error('scan sheet is empty');
  const header = grid[0].map(h => String(h ?? '').toLowerCase());
  const dateIdx = header.indexOf('date'), timeIdx = header.indexOf('time'), emailIdx = header.indexOf('email');
  if (dateIdx < 0 || timeIdx < 0 || emailIdx < 0) throw new Error('scan sheet has no Date/Time/Email columns');

  let done = 0;
  const appended: unknown[][] = [];
  for (const a of appts) {
    const email = a.email.toLowerCase();
    const date = isoToSheetDate(a.rawDateTime), time = isoToSheetTime(a.rawDateTime);
    // Every row for this account that has no time yet (one account can hold several seat rows).
    const rows = grid.map((r, i) => ({ r, i })).filter(({ r, i }) => i > 0 && String(r[emailIdx] ?? '').toLowerCase() === email);
    if (rows.length && rows.some(({ r }) => String(r[dateIdx] ?? '') !== '')) continue; // already scheduled
    if (rows.length) {
      for (const { i } of rows) {
        const cells = [date, time];
        const range = timeIdx === dateIdx + 1 ? `${colLetter(dateIdx)}${i + 1}:${colLetter(timeIdx)}${i + 1}` : null;
        if (range) await coreApiGoogle.sheets.updateValues(spreadsheetId, { range, values: [cells] });
        else {
          await coreApiGoogle.sheets.updateValues(spreadsheetId, { range: `${colLetter(dateIdx)}${i + 1}`, values: [[date]] });
          await coreApiGoogle.sheets.updateValues(spreadsheetId, { range: `${colLetter(timeIdx)}${i + 1}`, values: [[time]] });
        }
        done++;
      }
    } else {
      const row: unknown[] = new Array(header.length).fill('');
      row[dateIdx] = date; row[timeIdx] = time; row[emailIdx] = a.email;
      appended.push(row); done++;
    }
  }
  if (appended.length) await coreApiGoogle.sheets.appendValues(spreadsheetId, { range: 'A1', values: appended });
  return done;
}
