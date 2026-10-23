/**
 * Scan checklist (Eddie, 2026-10-23: "can we do check boxes for things like
 * this? usernames passwords presale codes I can check off what to scan for for
 * sure. also a 'pull current seating info' option").
 *
 * The Triage app sends which items to pull. Each ticked item gets its own
 * sheet column: Password fills the existing Password column, Username and
 * Presale Code are added as columns. Appointment times are always read.
 * Older app builds send only extractCodes / extractLinks and keep the old
 * behavior (the code goes in Password).
 */
import type { RecipientWithAppointment } from './gmail.js';

export interface ScanChecklist {
  username: boolean;
  password: boolean;
  presaleCode: boolean;
  links: boolean;
  seating: boolean;
}

/** Sheet header for the presale code column. */
export const PRESALE_CODE_COLUMN = 'Presale Code';

/** Seat columns left off the sheet when seating is unticked. */
export const SEATING_COLUMNS = ['Section', 'Row', 'Low Seat', 'High Seat', 'Qty', 'Pack', 'Pack Members', 'Season Total'];

export function parseChecklist(raw: unknown): ScanChecklist | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  return {
    username: c.username === true,
    password: c.password === true,
    presaleCode: c.presaleCode === true,
    links: c.links === true,
    // Seating defaults ON: only an explicit false leaves it off.
    seating: c.seating !== false,
  };
}

/**
 * Adds the username / password requests to the scan's AI instructions, which
 * return them as custom.username / custom.password.
 */
export function checklistInstructions(c: ScanChecklist, instructions?: string): string | undefined {
  const asks: string[] = [];
  if (c.username) asks.push('username: the login username or account number the email gives the recipient to sign in with');
  if (c.password) asks.push('password: the login password the email gives the recipient');
  const base = instructions?.trim();
  if (asks.length === 0) return base || undefined;
  return [base, ...asks].filter(Boolean).join('\n');
}

/**
 * Moves the presale code out of the Password column into its own column, and
 * drops it when it is just the login password read again.
 */
export function applyChecklist(recipients: RecipientWithAppointment[], c: ScanChecklist): void {
  for (const r of recipients) {
    const custom: Record<string, string | null> = { ...(r.custom ?? {}) };
    if (!c.username) delete custom.username;
    if (!c.password) delete custom.password;
    const code = r.code ?? null;
    if (c.presaleCode && code && code !== custom.password) custom[PRESALE_CODE_COLUMN] = code;
    r.code = null;
    if (!c.links) r.link = null;
    r.custom = Object.keys(custom).length ? custom : null;
  }
}

/** Removes the named columns from a header and its rows, in place. */
export function dropColumns(header: string[], rows: (string | number)[][], names: string[]): void {
  const drop = names.map(n => header.indexOf(n)).filter(i => i >= 0).sort((a, b) => b - a);
  for (const i of drop) {
    header.splice(i, 1);
    for (const row of rows) if (row.length > i) row.splice(i, 1);
  }
}
