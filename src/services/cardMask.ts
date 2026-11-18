/**
 * Hides payment card numbers in text before it is copied somewhere many people read.
 *
 * Why: the Slack to Monday sync copies a thread reply onto the Monday card word for word, and on 2026-10-23 one
 * reply put a full card number on a card. Monday boards are read by far more people than a Slack thread.
 *
 * What counts as a card number, and becomes "[card ending 1234]":
 *   1. an unbroken string of 13 to 19 digits, or
 *   2. digit groups in a card layout (4-4-4-4, 4-4-4-4-3, 4-4-4-3, 4-6-5, 4-6-4, 8-8) with up to three spaces,
 *      tabs, line breaks, dots or dashes of any kind between groups,
 * that starts with 2 to 6 and passes the card check digit test (Luhn).
 * A 3 or 4 digit code right after CVV, CVC or CID becomes "[hidden]". After "security code" only when the same message
 * held a card number, because a parking gate or door code ("Lot B gate security code: 4821") is working information.
 *
 * Left whole: the target of a Slack link (<https://...|label>, the label is still checked), so a link whose path holds a
 * long id keeps working, and a number written right after the word "barcode".
 *
 * What is left alone on purpose: phone numbers, SkyBox purchase numbers, order numbers and seat lists
 * ("seats 1 2 3 4 5 6 7 8 9 10 11 12"). Loose digit groups in any other layout are never joined into a card,
 * because a ticket thread is full of seat and row numbers. About one unrelated number in ten that does have a card
 * layout passes the check digit test by chance and is masked too. Its last four digits stay visible.
 *
 * Pure function, no network, no state.
 */

const LAYOUTS: number[][] = [
  [4, 4, 4, 4, 3],
  [4, 4, 4, 4],
  [4, 4, 4, 3],
  [4, 6, 5],
  [4, 6, 4],
  [8, 8],
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function isCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[2-6]/.test(digits)) return false;
  return luhnValid(digits);
}

function label(digits: string): string {
  return `[card ending ${digits.slice(-4)}]`;
}

/** One run of digits joined by short gaps (see DIGIT_RUN). Returns the run with any card in it masked. */
function maskRun(run: string, count: { cards: number }): string {
  const groups = [...run.matchAll(/[0-9]+/g)].map((m) => ({ text: m[0], start: m.index ?? 0 }));
  let out = '';
  let pos = 0;
  let i = 0;
  while (i < groups.length) {
    let take = 0;
    if (isCard(groups[i].text)) {
      take = 1;
    } else {
      for (const layout of LAYOUTS) {
        const slice = groups.slice(i, i + layout.length);
        if (slice.length === layout.length && slice.every((g, k) => g.text.length === layout[k])
          && isCard(slice.map((g) => g.text).join(''))) {
          take = layout.length;
          break;
        }
      }
    }
    if (!take) {
      i++;
      continue;
    }
    const last = groups[i + take - 1];
    const digits = groups.slice(i, i + take).map((g) => g.text).join('');
    out += run.slice(pos, groups[i].start) + label(digits);
    pos = last.start + last.text.length;
    i += take;
    count.cards++;
  }
  return out + run.slice(pos);
}

// Digit groups joined by up to three spaces, tabs, line breaks, non-breaking spaces, dots or dashes (hyphen, en dash,
// em dash, minus), so a number pasted as "4111  1111", "4111.1111" or split over two lines is still one run.
const DIGIT_RUN = /[0-9](?:[\s.\-\u2010-\u2015\u2212]{0,3}[0-9])*/g;
// A Slack link to a web page or mail address. Its target is left alone, its label is checked.
const URL_LINK = /<((?:https?|mailto):[^>|]*)(?:\|([^>]*))?>/g;
const BARCODE = /barcodes?\s*(?:#|:|no\.?)?\s*$/i;
// Slack turns some long digit runs into a phone link: <tel:4111111111111111|4111 1111 1111 1111>.
const TEL_LINK = /<tel:([^>|]*)(?:\|([^>]*))?>/g;
const CVV = /\b(cvv2?|cvc2?|cid)\b(\s*(?:is|:|#|-|=)?\s*)([0-9]{3,4})\b/gi;
const SECURITY_CODE = /\b(security code)\b(\s*(?:is|:|#|-|=)?\s*)([0-9]{3,4})\b/gi;

/** Applies fn to every part of text outside a Slack web link target. */
function outsideLinkTargets(text: string, fn: (part: string) => string): string {
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(URL_LINK)) {
    const at = m.index ?? 0;
    out += fn(text.slice(pos, at)) + '<' + m[1] + (m[2] !== undefined ? '|' + fn(m[2]) : '') + '>';
    pos = at + m[0].length;
  }
  return out + fn(text.slice(pos));
}

export interface MaskResult {
  text: string;
  cards: number;
  codes: number;
}

export function maskCardNumbersWithCount(input: string): MaskResult {
  const count = { cards: 0 };
  let codes = 0;
  let text = String(input ?? '');
  text = text.replace(TEL_LINK, (whole: string, target: string, shown?: string) => {
    for (const part of [shown ?? '', target]) {
      const inner = { cards: 0 };
      const masked = part.replace(DIGIT_RUN, (run: string) => maskRun(run, inner));
      if (inner.cards) {
        count.cards += 1;
        return masked.replace(/^[^\[]*/, '').replace(/[^\]]*$/, '');
      }
    }
    return whole;
  });
  text = outsideLinkTargets(text, (part) => part.replace(DIGIT_RUN, (run: string, at: number) =>
    (BARCODE.test(part.slice(Math.max(0, at - 16), at)) ? run : maskRun(run, count))));
  const hide = (_whole: string, word: string, gap: string) => {
    codes++;
    return `${word}${gap}[hidden]`;
  };
  text = outsideLinkTargets(text, (part) => part.replace(CVV, hide));
  if (count.cards) text = outsideLinkTargets(text, (part) => part.replace(SECURITY_CODE, hide));
  return { text, cards: count.cards, codes };
}

export function maskCardNumbers(input: string): string {
  return maskCardNumbersWithCount(input).text;
}
