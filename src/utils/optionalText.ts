/**
 * Clean an optional text value from an AI parse or a sheet cell.
 *
 * The issue call parser sometimes returns the literal word "null" (or "none",
 * "n/a", "undefined") instead of leaving a field out, which showed up in Slack
 * as "Related Thread: null". Those placeholder words and blank strings become
 * null so the caller leaves the line out.
 */
const PLACEHOLDERS = new Set(['null', 'none', 'n/a', 'na', 'undefined', 'nil', '-']);

export function cleanOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (PLACEHOLDERS.has(text.toLowerCase())) return null;
  return text;
}
