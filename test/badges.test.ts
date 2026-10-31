import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGES, earnedBadges, newlyEarned, type Earned } from '../src/domain/badges.ts';
import { check } from '../src/domain/equation.ts';
import type { Sign, Way } from '../src/domain/types.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

let next = 0;

/** A sign of Ada's with its own id; overrides as for `sign()`. */
const s = (overrides: Partial<Sign> = {}): Sign => {
  next += 1;
  const id = `01JS${String(next).padStart(22, '0')}`;
  return sign({ id, title: `Sign ${next}`, ...overrides });
};

/** A true way on a sign, by Ada unless said, its value and numbers worked out from the text. */
const w = (on: Sign, text: string, overrides: Partial<Way> = {}): Way => {
  const result = check(text);
  assert.ok(result.ok, text);
  next += 1;
  return way(on.id, {
    id: `way-${next}`,
    text,
    value: result.value,
    numbers: result.numbers,
    createdAt: '2026-02-01T12:00:00.000Z',
    ...overrides
  });
};

function earned(playerId: string, signs: Sign[], ways: Way[] = []): Map<string, Earned> {
  const bySign = new Map<string, Way[]>();
  for (const one of ways) bySign.set(one.signId, [...(bySign.get(one.signId) ?? []), one]);
  return new Map(earnedBadges(playerId, signs, bySign).map((e) => [e.id, e]));
}

const has = (playerId: string, id: string, signs: Sign[], ways: Way[] = []): boolean =>
  earned(playerId, signs, ways).has(id);

const onDays = (...days: string[]): Sign[] => days.map((foundOn) => s({ foundOn }));

const pinned = (lat: number, lng: number, approximate = false): Partial<Sign> => ({
  place: { label: 'Somewhere', state: 'MN', lat, lng, approximate }
});

test('the catalog has 28 badges, five of them secret, each with a road sign to draw', () => {
  assert.equal(BADGES.length, 28);
  assert.equal(BADGES.filter((b) => b.secret).length, 5);
  assert.equal(new Set(BADGES.map((b) => b.id)).size, 28);
  for (const b of BADGES) assert.ok(b.mark || b.steps, b.id);
});

test('First Sign: post one; being named on someone else’s isn’t posting', () => {
  const posted = s();
  assert.ok(has(ada.id, 'first-sign', [posted]));
  const named = s({ postedBy: ben.id, finders: [{ playerId: ada.id, name: ada.name, role: 'spotted' }] });
  assert.ok(!has(ada.id, 'first-sign', [named]));
});

test('Lookout: be a finder on another player’s sign, not your own', () => {
  const theirs = s({
    postedBy: ada.id,
    finders: [
      { playerId: ada.id, name: ada.name, role: 'found' },
      { playerId: ben.id, name: ben.name, role: 'spotted' }
    ]
  });
  assert.ok(has(ben.id, 'lookout', [theirs]));
  assert.ok(!has(ada.id, 'lookout', [theirs]));
});

test('Second Opinion: a way on someone else’s sign; a way on your own doesn’t count', () => {
  const adas = s();
  assert.ok(has(ben.id, 'second-opinion', [adas], [w(adas, '19 − 12 = 7', { playerId: ben.id })]));
  assert.ok(!has(ada.id, 'second-opinion', [adas], [w(adas, '19 − 12 = 7')]));
});

test('Cracked It: the first way on a sign posted unsolved; a way written with the post isn’t one', () => {
  const unsolved = s();
  const solved = w(unsolved, '7 + 12 = 19', { playerId: ben.id, createdAt: '2026-01-11T09:00:00.000Z' });
  assert.ok(has(ben.id, 'cracked-it', [unsolved], [solved]));

  const withPost = s();
  const posted = w(withPost, '7 + 12 = 19', { createdAt: withPost.postedAt });
  const later = w(withPost, '19 − 12 = 7', { playerId: ben.id });
  assert.ok(!has(ada.id, 'cracked-it', [withPost], [posted, later]));
  assert.ok(!has(ben.id, 'cracked-it', [withPost], [posted, later]), 'not the first way');
});

test('Cracked It: a blocked player’s first way still means the sign was solved', () => {
  const posted = s({ postedBy: ben.id, finders: [{ playerId: ben.id, name: ben.name, role: 'found' }] });
  const cy = '01JCCCCCCCCCCCCCCCCCCCCCCC';
  const first = w(posted, '7 + 12 = 19', { playerId: cy, createdAt: posted.postedAt });
  const later = w(posted, '19 − 12 = 7');
  const ways = new Map([[posted.id, [first, later]]]);
  assert.ok(!earnedBadges(ada.id, [posted], ways, new Set([cy])).some((e) => e.id === 'cracked-it'));
  assert.ok(
    !earnedBadges(ben.id, [posted], ways, new Set([cy])).some((e) => e.id === 'company' && e.on === '2026-01-10'),
    'and the blocked way brings no company'
  );
});

test('Another Way: two ways on one sign; one way each on two signs is not', () => {
  const one = s();
  const two = s();
  const first = w(one, '7 + 12 = 19', { createdAt: one.postedAt });
  assert.ok(has(ada.id, 'another-way', [one], [first, w(one, '19 − 7 = 12')]));
  assert.ok(!has(ada.id, 'another-way', [one, two], [first, w(two, '19 − 7 = 12')]));
});

test('Company: another player’s way on a sign you posted; your own ways bring no company', () => {
  const adas = s();
  const mine = w(adas, '7 + 12 = 19', { createdAt: adas.postedAt });
  const company = earned(
    ada.id,
    [adas],
    [mine, w(adas, '19 − 12 = 7', { playerId: ben.id, createdAt: '2026-03-04T18:00:00.000Z' })]
  ).get('company');
  assert.equal(company?.on, '2026-03-04');
  assert.ok(!has(ada.id, 'company', [adas], [mine, w(adas, '19 − 7 = 12')]));
});

test('Mile Markers: steps at 3, 5, 10 and 25 signs, each earned by the sign that reached it', () => {
  assert.ok(!has(ada.id, 'mile-markers', onDays('2026-01-01', '2026-02-01')));
  const three = onDays('2026-01-01', '2026-02-01', '2026-03-01');
  assert.deepEqual(
    [earned(ada.id, three).get('mile-markers')?.step, earned(ada.id, three).get('mile-markers')?.sign],
    [3, three[2]]
  );
  const four = onDays('2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01');
  assert.equal(earned(ada.id, four).get('mile-markers')?.step, 3);
  const five = [...four, ...onDays('2026-05-01')];
  assert.equal(earned(ada.id, five).get('mile-markers')?.step, 5);
  assert.equal(earned(ada.id, five).get('mile-markers')?.on, '2026-05-01');
});

test('States: steps from 2 states; signs without a state or in the same state don’t add one', () => {
  const mn = s();
  const wi = s({ place: { label: 'Hudson, Wisconsin', state: 'WI', approximate: true } });
  const nowhere = s({ place: { label: 'Somewhere on I-90', approximate: true } });
  assert.ok(!has(ada.id, 'states', [mn, s(), nowhere]));
  assert.equal(earned(ada.id, [mn, wi]).get('states')?.step, 2);
});

test('Home Turf: 5 signs in one state; 4 is not enough', () => {
  const four = onDays('2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01');
  assert.ok(!has(ada.id, 'home-turf', four));
  assert.ok(has(ada.id, 'home-turf', [...four, ...onDays('2026-05-01')]));
});

test('Far From Home: 500 miles from your first exact pin; an approximate pin never counts', () => {
  const minneapolis = s({ foundOn: '2026-01-01', ...pinned(44.98, -93.27) });
  const denver = s({ foundOn: '2026-02-01', ...pinned(39.74, -104.99) });
  const chicago = s({ foundOn: '2026-02-01', ...pinned(41.88, -87.63) });
  assert.ok(has(ada.id, 'far-from-home', [minneapolis, denver]));
  assert.ok(!has(ada.id, 'far-from-home', [minneapolis, chicago]), 'about 350 miles');
  const roughDenver = s({ foundOn: '2026-02-01', ...pinned(39.74, -104.99, true) });
  assert.ok(!has(ada.id, 'far-from-home', [minneapolis, roughDenver]));
});

test('Road Trip: two signs found within three days; four days apart is not one', () => {
  assert.ok(has(ada.id, 'road-trip', onDays('2026-06-01', '2026-06-04')));
  assert.ok(!has(ada.id, 'road-trip', onDays('2026-06-01', '2026-06-05')));
});

test('Four Seasons: winter, spring, summer and fall in any years, December counting as winter', () => {
  assert.ok(has(ada.id, 'four-seasons', onDays('2025-12-20', '2026-03-01', '2024-06-01', '2026-09-01')));
  assert.ok(!has(ada.id, 'four-seasons', onDays('2026-01-01', '2026-04-01', '2026-07-01', '2026-08-01')));
});

test('Still Playing: a sign a year after your first; 364 days is not a year', () => {
  assert.ok(has(ada.id, 'still-playing', onDays('2026-01-10', '2027-01-10')));
  assert.ok(!has(ada.id, 'still-playing', onDays('2026-01-10', '2027-01-09')));
});

test('a sign’s badges go to every finder who plays, not to people who don’t', () => {
  const found = onDays('2026-01-01', '2026-01-02', '2026-01-03').map((one) => ({
    ...one,
    finders: [
      { playerId: ada.id, name: ada.name, role: 'found' as const },
      { playerId: ben.id, name: ben.name, role: 'took_photo' as const },
      { name: 'A friend', role: 'spotted' as const }
    ]
  }));
  assert.equal(earned(ben.id, found).get('mile-markers')?.step, 3);
  assert.ok(has(ben.id, 'road-trip', found));
});

test('Times Table, Fair Share, Square Root, Power Up, Exclamation Point: one each, from the operation used', () => {
  const on = s();
  const cases: [string, string][] = [
    ['times-table', '7 × 12 = 84'],
    ['fair-share', '12 ÷ 4 = 3'],
    ['square-root', '√9 = 3'],
    ['power-up', '2^3 = 8'],
    ['exclamation-point', '3! = 6']
  ];
  for (const [id, text] of cases) {
    assert.ok(has(ada.id, id, [on], [w(on, text)]), id);
    assert.ok(!has(ada.id, id, [on], [w(on, '7 + 12 = 19')]), `${id} missed`);
  }
});

test('Whole Keypad: + − × ÷ √ ^ ! across ways; all but the minus is not enough', () => {
  const on = s();
  const most = [w(on, '√9 × 2 = 12 ÷ 2'), w(on, '2^3 + 1 = 3! + 3')];
  assert.ok(!has(ada.id, 'whole-keypad', [on], most));
  const all = earned(ada.id, [on], [...most, w(on, '7 − 1 = 6', { createdAt: '2026-04-01T18:00:00.000Z' })]);
  assert.equal(all.get('whole-keypad')?.on, '2026-04-01');
});

test('Every Number: a way using all of a sign’s three or more numbers', () => {
  const three = s();
  assert.ok(has(ada.id, 'every-number', [three], [w(three, '7 + 12 = 19')]));
  assert.ok(!has(ada.id, 'every-number', [three], [w(three, '7 × 1 = 7')]));
  const two = s({ numbers: [{ value: '7' }, { value: '7' }] });
  assert.ok(!has(ada.id, 'every-number', [two], [w(two, '7 = 7')]), 'two numbers are too few');
});

test('Half Mile: a decimal, or a division that comes to a fraction; whole numbers are not', () => {
  const on = s();
  assert.ok(has(ada.id, 'half-mile', [on], [w(on, '0.5 × 4 = 2')]));
  assert.ok(!has(ada.id, 'half-mile', [on], [w(on, '2 × 2 = 4')]));
  assert.ok(has(ada.id, 'half-mile', [on], [w(on, '1 ÷ 2 = 3 ÷ 6')]));
  assert.ok(has(ada.id, 'half-mile', [on], [w(on, '3 ÷ 6 × 2 = 1')]), 'a fraction on the way to a whole number');
  assert.ok(!has(ada.id, 'half-mile', [on], [w(on, '12 ÷ 4 = 3')]), 'a division that comes out whole');
});

test('Zero Sum and Big Number: what both sides come to', () => {
  const on = s();
  assert.ok(has(ada.id, 'zero-sum', [on], [w(on, '7 − 7 = 0')]));
  assert.ok(!has(ada.id, 'zero-sum', [on], [w(on, '7 − 6 = 1')]));
  assert.ok(has(ada.id, 'big-number', [on], [w(on, '10^3 = 1000')]));
  assert.ok(!has(ada.id, 'big-number', [on], [w(on, '999 = 999')]));
  assert.ok(has(ada.id, 'big-number', [on], [w(on, '4000 ÷ 3 = 8000 ÷ 6')]), 'a fraction, 4000/3');
  assert.ok(!has(ada.id, 'big-number', [on], [w(on, '2000 ÷ 3 = 4000 ÷ 6')]), '2000/3 is under 1000');
});

test('secret: The Answer and Taxicab need an exact 42 or 1729', () => {
  const on = s();
  assert.ok(has(ada.id, 'secret-1', [on], [w(on, '6 × 7 = 42')]));
  assert.ok(!has(ada.id, 'secret-1', [on], [w(on, '6 × 7 = 42', { value: '≈42' })]));
  assert.ok(!has(ada.id, 'secret-1', [on], [w(on, '6 × 7 + 1 = 43')]));
  assert.ok(has(ada.id, 'secret-3', [on], [w(on, '1729 = 1729')]));
  assert.ok(!has(ada.id, 'secret-3', [on], [w(on, '1728 = 1728')]));
});

test('secret: Palindrome reads the same backwards and does some math', () => {
  const on = s();
  assert.ok(has(ada.id, 'secret-4', [on], [w(on, '12 × 42 = 24 × 21')]));
  assert.ok(!has(ada.id, 'secret-4', [on], [w(on, '12 × 42 = 21 × 24')]));
  assert.ok(!has(ada.id, 'secret-4', [on], [w(on, '7 = 7')]), 'no math');
});

test('secret: Route 66 and Mile Zero come from the numbers on the sign', () => {
  const sixtySix = s({ numbers: [{ value: '66' }, { value: '6' }, { value: '11' }] });
  assert.ok(has(ada.id, 'secret-2', [sixtySix]));
  assert.ok(!has(ada.id, 'secret-2', [s({ numbers: [{ value: '6' }, { value: '6' }] })]));
  assert.ok(has(ada.id, 'secret-5', [s({ numbers: [{ value: '0' }, { value: '5' }, { value: '5' }] })]));
  assert.ok(!has(ada.id, 'secret-5', [s()]));
});

test('a way’s math badges go to its author alone', () => {
  const on = s();
  const bens = w(on, '7 × 12 = 84', { playerId: ben.id });
  assert.ok(has(ben.id, 'times-table', [on], [bens]));
  assert.ok(!has(ada.id, 'times-table', [on], [bens]));
});

test('held and hidden signs, and the ways on them, earn nothing', () => {
  for (const visibility of ['held', 'hidden'] as const) {
    const kept = s({ visibility, numbers: [{ value: '66' }] });
    const got = earned(ada.id, [kept], [w(kept, '6 × 7 = 42', { playerId: ada.id })]);
    assert.deepEqual([...got.keys()], [], visibility);
  }
});

test('earned badges come in catalog order, each with the first sign and day that earned it', () => {
  const first = s({ foundOn: '2026-01-01' });
  const second = s({ foundOn: '2026-02-01' });
  const got = earnedBadges(
    ada.id,
    [second, first],
    new Map([
      [first.id, [w(first, '7 × 12 = 84', { createdAt: '2026-01-02T18:00:00.000Z' })]],
      [second.id, [w(second, '2 × 2 = 4', { createdAt: '2026-02-02T18:00:00.000Z' })]]
    ])
  );
  assert.deepEqual(
    got.map((e) => e.id),
    BADGES.map((b) => b.id).filter((id) => got.some((e) => e.id === id))
  );
  const first_sign = got.find((e) => e.id === 'first-sign')!;
  assert.deepEqual([first_sign.sign.id, first_sign.on], [first.id, '2026-01-01']);
  const times = got.find((e) => e.id === 'times-table')!;
  assert.deepEqual([times.sign.id, times.on], [first.id, '2026-01-02']);
});

test('newly earned: a new badge or a higher step, never one already had', () => {
  const on = s();
  const before: Earned[] = [
    { id: 'first-sign', on: '2026-01-01', sign: on },
    { id: 'mile-markers', step: 3, on: '2026-01-01', sign: on }
  ];
  const after: Earned[] = [
    ...before.slice(0, 1),
    { id: 'mile-markers', step: 5, on: '2026-02-01', sign: on },
    { id: 'times-table', on: '2026-02-01', sign: on }
  ];
  assert.deepEqual(
    newlyEarned(before, after).map((e) => [e.id, e.step]),
    [
      ['mile-markers', 5],
      ['times-table', undefined]
    ]
  );
  assert.deepEqual(newlyEarned(after, after), []);
});

test('a way’s day: the found day when posted with its sign, else the day in US Central, never UTC’s', () => {
  // Posted at 10:24 pm Central on 30 October, which is already 31 October in UTC.
  const late = s({ foundOn: '2026-10-29', postedAt: '2026-10-31T03:24:00.000Z' });
  const withPost = w(late, '7 × 12 = 84', { createdAt: late.postedAt });
  assert.equal(earned(ada.id, [late], [withPost]).get('times-table')?.on, '2026-10-29');

  const other = s({ postedBy: ben.id, finders: [{ playerId: ben.id, name: ben.name, role: 'found' }] });
  const added = w(other, '7 × 12 = 84', { createdAt: '2026-10-31T03:24:00.000Z' });
  assert.equal(earned(ada.id, [other], [added]).get('second-opinion')?.on, '2026-10-30');
});
