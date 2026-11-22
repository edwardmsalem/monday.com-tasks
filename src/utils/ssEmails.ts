/**
 * SS email helpers for Accounts (NEW FLOW) 18391601434.
 *
 * Since 2026-11-22 the SS email lives in one text column, `ss_email_address`
 * ("SS Email Address"), which can hold several emails ("a@x.com, b@y.com").
 * The old email columns assoc_ss_email and lead_ss_email are being deleted.
 */
export const ACCOUNTS_SS_EMAIL_COL = 'ss_email_address';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every email in a cell, in order, trimmed, duplicates (any case) dropped. */
export function extractEmails(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of String(text ?? '').match(EMAIL_RE) ?? []) {
    const e = m.replace(/\.+$/, '');
    const k = e.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  }
  return out;
}

/** True when `email` is one of the emails in the cell (case-insensitive, exact address). */
export function cellHasEmail(text: string | null | undefined, email: string): boolean {
  const want = email.trim().toLowerCase();
  return want !== '' && extractEmails(text).some((e) => e.toLowerCase() === want);
}
