import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, numbersLeftOut, numbersNotOnSign, orderOnlyKey, sameWayKey, texOf } from '../src/domain/equation.ts';

type Vector = {
  text: string;
  ok: boolean;
  canonical?: string;
  value?: string;
  numbers?: string[];
  tex?: string;
  error?: string;
  note: string;
};
const vectors = JSON.parse(readFileSync(new URL('../contracts/equation-vectors.json', import.meta.url), 'utf8')) as {
  checks: Vector[];
  numbers_on_sign: { used: string[]; sign: string[]; missing: string[]; note: string }[];
  numbers_left_out: { used: string[]; sign: string[]; left_out: string[]; note: string }[];
};

for (const v of vectors.checks) {
  test(`check: ${v.note}: ${v.text || '(empty)'}`, () => {
    const r = check(v.text);
    if (v.ok) {
      assert.equal(r.ok, true, r.ok ? '' : r.message);
      if (!r.ok) return;
      assert.equal(r.canonical, v.canonical);
      assert.equal(r.value, v.value);
      assert.deepEqual(r.numbers, v.numbers);
      assert.equal(texOf(v.text), v.tex);
      assert.equal(texOf(r.canonical), v.tex);
    } else {
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.error, v.error, r.message);
      assert.ok(r.message.length > 0);
    }
  });
}

for (const v of vectors.numbers_on_sign) {
  test(`numbers on the sign: ${v.note}`, () => {
    assert.deepEqual(numbersNotOnSign(v.used, v.sign), v.missing);
  });
}

for (const v of vectors.numbers_left_out) {
  test(`numbers left out: ${v.note}`, () => {
    assert.deepEqual(numbersLeftOut(v.used, v.sign), v.left_out);
  });
}

test('a false way reports both sides', () => {
  const r = check('2 + 2 = 5');
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.values, ['4', '5']);
});

const sameWay = (
  JSON.parse(readFileSync(new URL('../contracts/equation-vectors.json', import.meta.url), 'utf8')) as {
    same_way: { a: string; b: string; same: boolean; note: string }[];
  }
).same_way;

for (const v of sameWay) {
  test(`same way: ${v.note}: ${v.a} and ${v.b}`, () => {
    assert.ok(check(v.a).ok, v.a);
    assert.ok(check(v.b).ok, v.b);
    const a = sameWayKey(v.a);
    assert.ok(a !== undefined);
    assert.equal(a === sameWayKey(v.b), v.same);
  });
}

test('every way is the same as itself, and math that doesn’t parse has no key', () => {
  for (const v of vectors.checks.filter((c) => c.ok)) assert.equal(sameWayKey(v.text), sameWayKey(v.canonical!));
  assert.equal(sameWayKey('3 +'), undefined);
});

test('do-nothing identities are the same way, at any depth and on either side (Jamie, 2026-11-12)', () => {
  const same = (a: string, b: string) => {
    assert.ok(check(a).ok && check(b).ok, `${a} | ${b}`);
    assert.equal(sameWayKey(a), sameWayKey(b), `${a} | ${b}`);
  };
  const differ = (a: string, b: string) => assert.notEqual(sameWayKey(a), sameWayKey(b), `${a} | ${b}`);
  same('2! × 3 = 6', '2 × 3 = 6');
  same('2 × 3 = 6', '6 = 3 × 2!');
  same('(2)! × 3 = 6', '2 × 3 = 6');
  same('1! + 6 = 7', '6 + 1 = 7');
  same('1!!! + 6 = 7', '1 + 6 = 7');
  same('√1 + 6 = 7', '1 + 6 = 7');
  same('√√1 + 6 = 7', '1 + 6 = 7');
  same('√(1) + 6 = 7', '1 + 6 = 7');
  same('6^1 + 1 = 7', '1 + 6 = 7');
  same('6^(1) + 1 = 7', '1 + 6 = 7');
  same('6^1^1 + 1 = 7', '1 + 6 = 7');
  same('6^1! + 1 = 7', '1 + 6 = 7');
  same('−(−6) + 1 = 7', '1 + 6 = 7');
  same('−−6 + 1 = 7', '6 + 1 = 7');
  same('−(−(6 + 1)) = 7', '7 = 1 + 6');
  same('2 × −(−3) = 6', '3 × 2 = 6');
  same('√(2!^1 + 2) = 2', '√(2 + 2) = 2');
  same('(3 + 1!)^2 = 16', '(1 + 3)^2 = 16');
  same('12 ÷ (2 + 2!) = 3', '12 ÷ (2 + 2) = 3');
  same('7 − (2! + 1) = 4', '7 − (1 + 2) = 4');
  // The do-nothing identity goes; what it stood on keeps every other rule.
  differ('7 − (2! + 1) = 4', '7 − 2 + 1 = 6');
  // Three negations are one.
  same('−(−(−3)) + 5 = 2', '−3 + 5 = 2');
  differ('−(−(−3)) + 5 = 2', '3 + 5 = 8');
  // Not on the list: each stays a new way.
  differ('3! = 6', '3 = 6');
  differ('(1 + 1)! = 2', '1 + 1 = 2');
  differ('√4 + 1 = 3', '2 + 1 = 3');
  differ('3 × 1 = 3', '3 = 3');
  differ('3 + 0 = 3', '3 = 3');
  differ('3^0 = 1', '1 = 1');
  differ('3^(2 − 1) = 3', '3 = 3');
  differ('3^−1 × 3 = 1', '3 × 3 = 1');
  differ('0! + 2 = 3', '1 + 2 = 3');
  differ('5 − (−3) = 8', '5 + 3 = 8');
});

test('the order-only key is the rule from before the identities, which the old SAME rows used', () => {
  assert.equal(orderOnlyKey('3 + 4 = 7'), sameWayKey('4 + 3 = 7'));
  assert.equal(orderOnlyKey('7 = 4 + 3'), orderOnlyKey('3 + 4 = 7'));
  assert.notEqual(orderOnlyKey('2! + 3 = 5'), orderOnlyKey('2 + 3 = 5'));
  assert.equal(orderOnlyKey('3 +'), undefined);
  // For a way with no identity in it the two keys agree, so its old row is today's row.
  for (const v of vectors.checks.filter((c) => c.ok)) {
    const hasIdentity = /[12]!|√1(?!\d)|\^1(?!\d)|−\(?−/.test(v.text);
    if (!hasIdentity) assert.equal(orderOnlyKey(v.text), sameWayKey(v.text), v.text);
  }
  // Today's key never reads like an old key with an identity in it, so an old row can't match a new way wrongly.
  for (const text of ['2! + 3 = 5', '1! × 6 = 6', '√1 × 6 = 6', '3^1 + 4 = 7', '−(−3) + 4 = 7', '5 − −(−2) = 3']) {
    assert.notEqual(sameWayKey(text), orderOnlyKey(text), text);
    assert.doesNotMatch(sameWayKey(text)!, /!\([12]\)|√\(1\)|,1\)|−\(−\(/, text);
  }
});
