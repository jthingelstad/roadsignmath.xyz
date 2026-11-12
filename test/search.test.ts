import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { SIGN_SEARCH_JS } from '../src/web/search.ts';

// The same text the page runs, run here on its own, as a browser would.
const matches = runInNewContext(`${SIGN_SEARCH_JS}; rsmSignMatches`) as (sign: unknown, query: string) => boolean;

const sign = {
  title: 'I-35W at 82nd Street',
  place: { label: 'Bloomington, Minnesota', state: 'MN' },
  finders: [{ name: 'Zoë Example', handle: 'zoe' }],
  numbers: [{ value: '2' }, { value: '90' }, { value: '7' }],
  ways: [{ text: '90 − 82 = 8' }]
};

test('search finds a sign by its title, place, state, finder or math, ignoring case and accents', () => {
  for (const q of ['i-35w', '82nd', 'bloomington', 'MINNESOTA', 'mn', 'zoe', 'Zoë', 'zoe bloomington', '90 − 82']) {
    assert.ok(matches(sign, q), q);
  }
  for (const q of ['iowa', 'zoe iowa', 'tyler']) assert.ok(!matches(sign, q), q);
});

test('a number matches one of the sign’s numbers, or stands on its own in the title or place', () => {
  assert.ok(matches(sign, '90'));
  assert.ok(matches(sign, '7'));
  // "35" is in I-35W and "82" in 82nd, but "3" and "5" are neither a number nor on their own.
  assert.ok(matches(sign, '35'));
  assert.ok(matches(sign, '82'));
  assert.ok(!matches(sign, '3'));
  assert.ok(!matches(sign, '5'));
  assert.ok(!matches(sign, '335'));
});

test('an empty query, or one of only punctuation, matches nothing', () => {
  assert.ok(!matches(sign, ''));
  assert.ok(!matches(sign, '  - . '));
  // A sign missing a part is searched without it.
  assert.ok(matches({ title: 'Bare' }, 'bare'));
});
