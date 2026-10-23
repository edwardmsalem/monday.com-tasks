/**
 * Scan watcher sheet updates (Eddie, 2026-10-22: "when I do a scan I want to be
 * able to monitor for more incoming emails of the same subject and to have the
 * sheet updated as it comes in").
 *
 * Adds recipients found in NEW emails to an existing scan sheet without
 * disturbing what the team typed into it:
 * - already in the top (scanned) section: fills Date / Time / Password;
 * - listed under "NO APPOINTMENT": the row(s) move up to the end of the
 *   scanned section, get Date / Time / Password, and the section count updates;
 * - not on the sheet: a row is inserted at the end of the scanned section,
 *   with account details when the team sheet knows the email.
 * Extracted fields (Username, Password, Presale Code) go in the column with
 * the same name when the sheet has one.
 * Only targeted cells and row moves/inserts are written.
 */
import { google as coreApiGoogle } from './coreApi.js';
import { isoToSheetDate, isoToSheetTime, type ScanAccountInfo } from './sheets.js';
import type { RecipientWithAppointment } from './gmail.js';

/** Email text is untrusted: never let it become a formula in the sheet. */
const safe = (v: string | number): string | number =>
  typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;

const colLetter = (i: number): string => {
  let n = i + 1, out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

export async function addRecipientsToScanSheet(
  spreadsheetId: string,
  sheetGid: number,
  recipients: RecipientWithAppointment[],
  accountInfo?: Map<string, ScanAccountInfo>
): Promise<number> {
  let changed = 0;
  for (const r of recipients) {
    const email = r.email.toLowerCase();
    // Re-read each time: earlier moves/inserts shift row positions.
    const values = (await coreApiGoogle.sheets.getValues(spreadsheetId, 'Recipients!A1:ZZ')) as string[][];
    if (!values.length) return changed;
    const header = values[0].map(h => String(h));
    const col = (name: string) => header.indexOf(name);
    const headerLower = header.map(h => h.toLowerCase());
    const customCells = Object.entries(r.custom ?? {})
      .map(([k, v]) => ({ c: headerLower.indexOf(k.toLowerCase()), v }))
      .filter((x): x is { c: number; v: string } => x.c >= 0 && !!x.v);
    const emailCol = col('Email'), dateCol = col('Date'), timeCol = col('Time'), pwCol = col('Password');
    if (emailCol < 0) return changed;

    const sectionIdx = values.findIndex(row => String(row?.[0] ?? '').startsWith('NO APPOINTMENT'));
    // Scanned section ends at the blank separator above "NO APPOINTMENT", or the bottom.
    const scannedEnd = sectionIdx > 0 ? sectionIdx - 1 : values.length;
    const rowsFor = (from: number, to: number) => {
      const out: number[] = [];
      for (let i = from; i < to; i++) if (String(values[i]?.[emailCol] ?? '').toLowerCase() === email) out.push(i);
      return out;
    };
    const dateVal = isoToSheetDate(r.rawDateTime);
    const timeVal = isoToSheetTime(r.rawDateTime);
    const fillRow = async (rowIdx: number) => {
      const cells: Array<{ c: number; v: string | number }> = [];
      if (dateCol >= 0 && dateVal !== '') cells.push({ c: dateCol, v: dateVal });
      if (timeCol >= 0 && timeVal !== '') cells.push({ c: timeCol, v: timeVal });
      if (pwCol >= 0 && r.code) cells.push({ c: pwCol, v: r.code });
      cells.push(...customCells);
      for (const { c, v } of cells) {
        await coreApiGoogle.sheets.updateValues(spreadsheetId, { range: `Recipients!${colLetter(c)}${rowIdx + 1}`, values: [[safe(v)]] });
      }
    };

    const inScanned = rowsFor(1, scannedEnd);
    if (inScanned.length > 0) {
      for (const i of inScanned) await fillRow(i);
      changed++;
      continue;
    }

    const inNoAppt = sectionIdx > 0 ? rowsFor(sectionIdx + 1, values.length) : [];
    if (inNoAppt.length > 0) {
      // Move each row (bottom first keeps indexes valid) to the end of the
      // scanned section; they land at scannedEnd .. scannedEnd + n - 1.
      for (const i of [...inNoAppt].sort((a, b) => b - a)) {
        await coreApiGoogle.sheets.batchUpdate(spreadsheetId, [{
          moveDimension: {
            source: { sheetId: sheetGid, dimension: 'ROWS', startIndex: i, endIndex: i + 1 },
            destinationIndex: scannedEnd,
          },
        }]);
      }
      for (let k = 0; k < inNoAppt.length; k++) await fillRow(scannedEnd + k);
      // The section header slid down by the moved rows; refresh its count.
      const headerRow = sectionIdx + inNoAppt.length;
      const remaining = Math.max(0, values.length - 1 - sectionIdx - inNoAppt.length);
      await coreApiGoogle.sheets.updateValues(spreadsheetId, {
        range: `Recipients!A${headerRow + 1}`,
        values: [[`NO APPOINTMENT (${remaining})`]],
      });
      changed++;
      continue;
    }

    // Not on the sheet: insert a new row at the end of the scanned section.
    const account = accountInfo?.get(email);
    const row: (string | number)[] = new Array(header.length).fill('');
    row[emailCol] = r.email;
    if (dateCol >= 0) row[dateCol] = dateVal;
    if (timeCol >= 0) row[timeCol] = timeVal;
    if (pwCol >= 0) row[pwCol] = r.code || '';
    const set = (name: string, v: string) => { const i = col(name); if (i >= 0) row[i] = v; };
    if (account) {
      set('Name', account.name); set('Plan Type', account.planType);
      const loc = account.seatLocations[0];
      if (loc) {
        set('Section', loc.section); set('Row', loc.row);
        set('Low Seat', loc.lowSeat ? String(loc.lowSeat) : ''); set('High Seat', loc.highSeat ? String(loc.highSeat) : '');
        set('Qty', loc.qty); set('Season Total', loc.seasonTotal);
      }
      set('Last 4', account.last4); set('Exp', account.exp); set('CVV', account.cvv); set('Billing Address', account.billingAddress);
    }
    for (const { c, v } of customCells) row[c] = v;
    if (r.additionalAppointment) set('Notes', r.additionalAppointment);
    await coreApiGoogle.sheets.batchUpdate(spreadsheetId, [{
      insertDimension: { range: { sheetId: sheetGid, dimension: 'ROWS', startIndex: scannedEnd, endIndex: scannedEnd + 1 }, inheritFromBefore: true },
    }]);
    await coreApiGoogle.sheets.updateValues(spreadsheetId, { range: `Recipients!A${scannedEnd + 1}`, values: [row.map(safe)] });
    changed++;
  }

  if (changed > 0) {
    // Keep the Date / Time columns formatted over the grown range.
    await coreApiGoogle.sheets.batchUpdate(spreadsheetId, [
      { repeatCell: { range: { sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'ddd M/d' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'h:mm AM/PM' } } }, fields: 'userEnteredFormat.numberFormat' } },
    ]);
  }
  return changed;
}
