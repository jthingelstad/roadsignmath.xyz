import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, numbersLeftOut, numbersNotOnSign, sameWayKey, texOf } from '../src/domain/equation.ts';

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
