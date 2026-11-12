// Run with: npx tsx --test test/cardMask.test.ts   (node's built-in test runner through tsx, like test/oldBoards.test.ts)
// Card numbers below are the public test numbers card networks publish. None is a real card.
import test from 'node:test';
import assert from 'node:assert';
import { maskCardNumbers, maskCardNumbersWithCount } from '../src/services/cardMask.js';

test('a 16 digit card typed plain is masked to its last four', () => {
  assert.strictEqual(maskCardNumbers('use 4111111111111111 exp 04/29'), 'use [card ending 1111] exp 04/29');
});

test('spaces and dashes between groups are handled', () => {
  assert.strictEqual(maskCardNumbers('card 4111 1111 1111 1111 please'), 'card [card ending 1111] please');
  assert.strictEqual(maskCardNumbers('card 5555-5555-5555-4444.'), 'card [card ending 4444].');
});

test('a 15 digit card (Amex shape) is masked', () => {
  assert.strictEqual(maskCardNumbers('amex 3782 822463 10005'), 'amex [card ending 0005]');
});

test('a 13 digit and a 19 digit card are masked', () => {
  assert.strictEqual(maskCardNumbers('4222222222222'), '[card ending 2222]');
  assert.strictEqual(maskCardNumbers('6304000000000000000'), '[card ending 0000]');
});

test('two cards in one reply are both masked and counted', () => {
  const r = maskCardNumbersWithCount('old 4111111111111111 new 5555555555554444');
  assert.strictEqual(r.text, 'old [card ending 1111] new [card ending 4444]');
  assert.strictEqual(r.cards, 2);
});

test('a Slack phone link wrapped around a card is replaced whole', () => {
  assert.strictEqual(
    maskCardNumbers('here <tel:4111111111111111|4111 1111 1111 1111> thanks'),
    'here [card ending 1111] thanks',
  );
});

test('a real phone link is left alone', () => {
  const t = 'call <tel:+17185550123|718-555-0123>';
  assert.strictEqual(maskCardNumbers(t), t);
});

test('a security code after CVV is hidden', () => {
  const r = maskCardNumbersWithCount('4111111111111111 exp 04/29 cvv 123');
  assert.strictEqual(r.text, '[card ending 1111] exp 04/29 cvv [hidden]');
  assert.strictEqual(r.codes, 1);
  assert.strictEqual(maskCardNumbers('CVC: 9876'), 'CVC: [hidden]');
  assert.strictEqual(maskCardNumbers('cvv=123'), 'cvv=[hidden]');
  assert.strictEqual(maskCardNumbers('amex CID 1234'), 'amex CID [hidden]');
  assert.strictEqual(maskCardNumbers('4111111111111111 security code is 321'), '[card ending 1111] security code is [hidden]');
});

test('a gate or door code after "security code" stays readable when the message has no card', () => {
  for (const t of ['Lot B gate security code: 4821, enter by 6 PM', 'the lot gate security code is 4821']) {
    assert.strictEqual(maskCardNumbers(t), t, t);
  }
});

test('groups split by two spaces, a tab, a new line, a non-breaking space, dots or any dash are one card', () => {
  for (const [t, last] of [
    ['card 4111  1111  1111  1111 exp 04/29', '1111'],
    ['card 4111\u00a01111\u00a01111\u00a01111', '1111'],
    ['4111\t1111\t1111\t1111', '1111'],
    ['4111 1111\n1111 1111', '1111'],
    ['card 4111.1111.1111.1111', '1111'],
    ['card 5555\u20135555\u20135555\u20134444', '4444'],
    ['4111 - 1111 - 1111 - 1111', '1111'],
  ]) {
    const out = maskCardNumbers(t);
    assert.ok(out.includes(`[card ending ${last}]`), JSON.stringify(out));
    assert.ok(!out.replace(/\D/g, '').includes('11111111') && !out.includes('5555'), JSON.stringify(out));
  }
});

test('Amex typed in fours (4-4-4-3) and a card typed as two halves (8-8) are masked', () => {
  assert.strictEqual(maskCardNumbers('amex 3782 8224 6310 005'), 'amex [card ending 0005]');
  assert.strictEqual(maskCardNumbers('41111111 11111111'), '[card ending 1111]');
});

test('a card in code marks, bold, glued to a label or to letters is masked', () => {
  for (const t of ['`4111 1111 1111 1111`', '*4111111111111111*', 'cc#4111111111111111', '4111111111111111x']) {
    assert.ok(!maskCardNumbers(t).includes('4111'), t);
  }
});

test('a Slack link target is left whole, its label is still checked', () => {
  for (const t of [
    'see <https://example.com/orders/4111111111111111/view|the order>',
    'see <https://salemseatsllc.slack.com/archives/C06BSL06WJK/p1794248495355419|thread>',
    'see <https://example.com/x?cid=C06BSL06WJK&cvv=123|link>',
  ]) assert.strictEqual(maskCardNumbers(t), t, t);
  assert.strictEqual(maskCardNumbers('<https://example.com/a|card 4111 1111 1111 1111>'), '<https://example.com/a|card [card ending 1111]>');
  assert.strictEqual(maskCardNumbers('a <https://example.com/a|b> then 4111111111111111'), 'a <https://example.com/a|b> then [card ending 1111]');
});

test('a number written right after "barcode" is left alone', () => {
  for (const t of ['barcode 4539578763621486 for seat 5', 'Barcode: 4539578763621486', 'barcodes 4539578763621486']) {
    assert.strictEqual(maskCardNumbers(t), t, t);
  }
  assert.strictEqual(maskCardNumbers('barcode 12 then card 4111111111111111'), 'barcode 12 then card [card ending 1111]');
  assert.strictEqual(maskCardNumbers('no barcode, card 4111111111111111'), 'no barcode, card [card ending 1111]');
});

test('numbers that are not cards are left alone', () => {
  for (const t of [
    'SkyBox PO 418053815 is entered',                // 9 digits
    'order 1074045401 and 82176276',                 // vendor order numbers
    'call me at 718-490-6444 or +1 310 801 1355',    // phones
    'tracking 1234567890123456',                     // 16 digits, fails the check digit test
    'Slack ts 1794253288.880319',
    'total $26,769.08 for 12 seats, sec 104 row 7',
    'last 4 is 1111, exp 04/29',
    '0000000000000000',
  ]) assert.strictEqual(maskCardNumbers(t), t, t);
});

test('a card right after another number is still found', () => {
  assert.strictEqual(maskCardNumbers('PO 418053815 4111 1111 1111 1111'), 'PO 418053815 [card ending 1111]');
  assert.strictEqual(maskCardNumbers('ref 12345 5555-5555-5555-4444 ok'), 'ref 12345 [card ending 4444] ok');
  assert.strictEqual(maskCardNumbers('4111 1111 1111 1111 04/29'), '[card ending 1111] 04/29');
  assert.strictEqual(maskCardNumbers('718 490 6444 4111 1111 1111 1111'), '718 490 6444 [card ending 1111]');
});

test('seat lists and loose digit groups are never joined into a card', () => {
  for (const t of [
    'seats 1 2 3 4 5 6 7 8 9 10 11 12 13 14',
    'sec 101 102 103 104 105 row 7',
    'rows 11 12 13 14 15 16 17 18',
    '41 11 11 11 11 11 11 11',                        // card digits in a layout no card uses
    '4111 1111 1111 111',                             // one digit short
    '9111 1111 1111 1115',                            // layout fits, first digit is not a card range
    '2026-11-20 19:30 and 2026-11-21 13:00',
  ]) assert.strictEqual(maskCardNumbers(t), t, t);
});

test('every plain 13 to 19 digit number that fails the check digit test is untouched (1,000 samples)', () => {
  let state = 12345;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
  let masked = 0;
  for (let i = 0; i < 1000; i++) {
    const len = 13 + (next() % 7);
    let digits = String(2 + (next() % 5));
    while (digits.length < len) digits += String(next() % 10);
    const out = maskCardNumbers(`n ${digits} end`);
    if (out !== `n ${digits} end`) {
      masked++;
      assert.strictEqual(out, `n [card ending ${digits.slice(-4)}] end`);
    }
  }
  assert.ok(masked > 50 && masked < 160, `about one in ten passes by chance, got ${masked} of 1000`);
});

test('a card glued to more digits is not a card', () => {
  const t = '41111111111111110000000';                // 23 digits
  assert.strictEqual(maskCardNumbers(t), t);
  // 23 digits that do pass the check digit test are still too long to be a card.
  const luhn = (d: string) => [...d].reverse().reduce((sum, ch, i) => { let n = Number(ch); if (i % 2) { n *= 2; if (n > 9) n -= 9; } return sum + n; }, 0) % 10 === 0;
  const long = [...'0123456789'].map((c) => '4111111111111111000000' + c).find(luhn) as string;
  assert.strictEqual(long.length, 23);
  assert.strictEqual(maskCardNumbers(`id ${long}`), `id ${long}`);
});

test('the rest of the reply is unchanged', () => {
  const t = 'Thanks <@U095UQDRVK7>, see <https://example.com|the sheet>. Card 4111111111111111.\nSecond line.';
  assert.strictEqual(
    maskCardNumbers(t),
    'Thanks <@U095UQDRVK7>, see <https://example.com|the sheet>. Card [card ending 1111].\nSecond line.',
  );
});

test('empty and missing text do not throw', () => {
  assert.strictEqual(maskCardNumbers(''), '');
  assert.strictEqual(maskCardNumbers(undefined as unknown as string), '');
});

test('no full card number survives in the output', () => {
  const cards = ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '3530111333300000'];
  for (const c of cards) {
    const out = maskCardNumbers(`pay with ${c} today`);
    assert.ok(!out.includes(c), c);
    assert.ok(out.includes(`[card ending ${c.slice(-4)}]`), out);
  }
});
