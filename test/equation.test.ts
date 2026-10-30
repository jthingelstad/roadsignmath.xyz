import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, numbersNotOnSign } from '../src/domain/equation.ts';

type Vector = {
  text: string;
  ok: boolean;
  canonical?: string;
  value?: string;
  numbers?: string[];
  error?: string;
  note: string;
};
const vectors = JSON.parse(readFileSync(new URL('../contracts/equation-vectors.json', import.meta.url), 'utf8')) as {
  checks: Vector[];
  numbers_on_sign: { used: string[]; sign: string[]; missing: string[]; note: string }[];
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

test('a false way reports both sides', () => {
  const r = check('2 + 2 = 5');
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.values, ['4', '5']);
});
