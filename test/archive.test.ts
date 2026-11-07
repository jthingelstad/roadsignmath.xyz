import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  buildArchivePlan,
  captionOf,
  latexToWay,
  linkEmails,
  loadArchive,
  tidyWay,
  type ArchivePlan,
  type ArchivePost,
  type ArchiveSeed
} from '../src/seed/archive.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { check, numbersNotOnSign } from '../src/domain/equation.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';

test('old LaTeX becomes the text a player types', () => {
  assert.equal(latexToWay('20 + 1 = 21'), '20 + 1 = 21');
  assert.equal(latexToWay('6 \\times 1 = 6'), '6 × 1 = 6');
  assert.equal(latexToWay('\\sqrt{16} = 4'), '√(16) = 4');
  assert.equal(latexToWay('\\frac{8}{2} = 4'), '((8) ÷ (2)) = 4');
  assert.equal(latexToWay('2^{4} = 16'), '2^(4) = 16');
  assert.equal(tidyWay(latexToWay('\\left(2 + 3\\right) \\cdot 2 = 10')!), '(2 + 3) × 2 = 10');
  assert.equal(latexToWay('1,000 + 1 = 1001'), '1000 + 1 = 1001');
});

test('a fraction keeps its arguments until the math inside them has converted', () => {
  const cases: [string, string][] = [
    ['\\frac{2^{4}}{2} = 8', '2^4 ÷ 2 = 8'],
    ['\\frac{\\sqrt{16}}{2} = 2', '√16 ÷ 2 = 2'],
    ['\\frac{\\frac{8}{2}}{2} = 2', '8 ÷ 2 ÷ 2 = 2'],
    ['\\frac{6}{\\frac{4}{2}} = 3', '6 ÷ (4 ÷ 2) = 3'],
    ['\\sqrt{\\frac{32}{2}} = 4', '√(32 ÷ 2) = 4'],
    ['\\frac{{2} + 4}{3} = 2', '(2 + 4) ÷ 3 = 2'],
    ['2^{\\frac{4}{2}} = 4', '2^(4 ÷ 2) = 4']
  ];
  for (const [tex, want] of cases) assert.equal(tidyWay(latexToWay(tex) ?? 'none'), want, tex);
});

test('math the checker has no way to read is left out, not guessed at', () => {
  for (const tex of ['\\pi = 3.14', '7 \\mod 3 = 1', '\\sin 0 = 0', '2 \\approx 2', 'y + 1 = 2']) {
    assert.equal(latexToWay(tex), undefined, tex);
  }
});

test('parentheses the math does not need go, the ones it needs stay', () => {
  assert.equal(tidyWay('√(16) = 4'), '√16 = 4');
  assert.equal(tidyWay('(((2^4)) ÷ ((2))) = 8'), '2^4 ÷ 2 = 8');
  assert.equal(tidyWay('2 + (3 × 4) = 14'), '2 + 3 × 4 = 14');
  assert.equal(tidyWay('(2 + 3) × 4 = 20'), '(2 + 3) × 4 = 20');
  assert.equal(tidyWay('√(5 − 1) = 2'), '√(5 − 1) = 2');
  assert.equal(tidyWay('(10 − 6)! = 24'), '(10 − 6)! = 24');
  assert.equal(tidyWay('8 − (3 − 1) = 6'), '8 − (3 − 1) = 6');
});

test('a caption keeps the old words and leaves the rest behind', () => {
  const body = [
    'Ada found this one on a [long trip](2005-01-01-other.md).',
    '![Testville](../images/20050101-Testville.jpg)',
    'The **math** here is *simple*.',
    '$$\n2 + 2 = 4\n$$',
    'This sign scores 3 points.',
    'The math reads like this:',
    '> A letter from Ada.',
    'It sits on route 5 just before you cross the'
  ].join('\n\n');
  assert.equal(captionOf(body), 'Ada found this one on a long trip. The math here is simple. A letter from Ada.');
  assert.equal(captionOf('![A](x.jpg)\n\n$$\n1 = 1\n$$\n'), undefined);
});

test('a caption stops at a whole sentence under the limit, and titles do not end a sentence', () => {
  const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of the post.`).join(' ');
  const caption = captionOf(long)!;
  assert.ok(caption.length <= 500);
  assert.ok(caption.endsWith('.'));
  assert.ok(captionOf('Thanks to Mr. Brennan. '.repeat(30))!.endsWith('Brennan.'));
  assert.equal(
    captionOf('"Nothing." -- Henry F. Amiel\n\nIt began here.'),
    '"Nothing." -- Henry F. Amiel. It began here.'
  );
});

const post = (stem: string, title: string, finder: string, extra: Partial<ArchivePost['meta']> = {}): ArchivePost => ({
  stem,
  body: `${finder} found ${title}.\n`,
  meta: {
    title,
    found_by: finder,
    numbers: [2, 3, 5],
    math: ['2 + 3 = 5'],
    location: { city: 'Testville', state: 'Minnesota', country: 'United States', coordinates: [44.9, -93.2] },
    photos: [{ file: `${stem}.jpg`, image: `${stem}.jpg` }],
    ...extra
  }
});

const seed: ArchiveSeed = {
  existing: { 'Ada Example': 'ada' },
  fixes: {},
  photo_swaps: {},
  dates: {
    a: { posted_at: '2005-03-08T12:40:00.000Z', found_on: '2005-03-07' },
    b: { posted_at: '2006-07-01T17:00:00.000Z', found_on: '2006-07-01' },
    c: { posted_at: '2005-01-02T17:00:00.000Z', found_on: '2005-01-02' }
  }
};

test('a sign carries its old dates all the way through', () => {
  const plan = buildArchivePlan([post('a', 'Oldest', 'Ben Example')], seed);
  const [sign] = plan.signs;
  const [way] = plan.ways;
  assert.equal(sign.postedAt, '2005-03-08T12:40:00.000Z');
  assert.equal(sign.foundOn, '2005-03-07');
  // `postedUnsolved` reads a first way at any other time as a sign posted without one.
  assert.equal(way.createdAt, sign.postedAt);
  assert.equal(plan.players[0].player.createdAt, sign.postedAt);
});

test('a sign found after its post, or with no dates, stops the plan and names the sign', () => {
  const late = { ...seed, dates: { a: { posted_at: '2005-03-08T12:40:00.000Z', found_on: '2005-03-09' } } };
  assert.throws(() => buildArchivePlan([post('a', 'Late', 'Ben Example')], late), /Late: found 2005-03-09/);
  assert.throws(() => buildArchivePlan([post('zzz', 'Undated', 'Ben Example')], seed), /Undated: no dates/);
  // Evening in Central is already the next day in UTC: the post's day is the Central one.
  const evening = { ...seed, dates: { a: { posted_at: '2005-03-09T04:00:00.000Z', found_on: '2005-03-09' } } };
  assert.throws(() => buildArchivePlan([post('a', 'Evening', 'Ben Example')], evening), /Evening: found/);
});

test('only a sign with a photo, coordinates and a way the checker accepts comes over', () => {
  const plan = buildArchivePlan(
    [
      post('a', 'Keeps', 'Ben Example'),
      post('b', 'No Photo', 'Ben Example', { photos: [{ file: 'lost.jpg' }] }),
      post('b', 'Pi', 'Ben Example', { math: ['\\pi = 3.14'] }),
      post('b', 'Off Sign', 'Ben Example', { math: ['2 + 7 = 9'] }),
      post('b', 'False', 'Ben Example', { math: ['2 + 3 = 6'] }),
      post('b', 'Neither', 'Ben Example', { photos: [], math: [] }),
      post('b', 'No Pin', 'Ben Example', { location: { city: 'Testville', state: 'Minnesota' } }),
      post('c', 'Town Center', 'Ben Example')
    ],
    { ...seed, fixes: { c: { approximate: true } } }
  );
  // A pin on the town's center is still coordinates, so it comes over. Oldest post first.
  assert.deepEqual(
    plan.signs.map((s) => s.title),
    ['Town Center', 'Keeps']
  );
  assert.equal(plan.signs[0].place.approximate, true);
  assert.deepEqual(
    new Map(plan.left.map((l) => [l.title, l.why])),
    new Map([
      ['No Photo', ['no photo']],
      ['Pi', ['no way the checker accepts']],
      ['Off Sign', ['no way the checker accepts']],
      ['False', ['no way the checker accepts']],
      ['Neither', ['no photo', 'no way the checker accepts']],
      ['No Pin', ['no coordinates']]
    ])
  );
});

test('the finder posts the sign and a named solver gets their way', () => {
  const plan = buildArchivePlan(
    [
      post('a', 'Two Ways', 'Ben Example', {
        numbers: [2, 3, 5, 1],
        solutions: [{ by: 'Cal Example', math: '5 - 3 = 2' }],
        math: ['2 + 3 = 5', '5 - 3 = 2']
      })
    ],
    seed
  );
  const names = new Map(plan.players.map((p) => [p.player.id, p.player.name]));
  const [sign] = plan.signs;
  assert.equal(names.get(sign.postedBy), 'Ben Example');
  assert.equal(sign.finders[0].name, 'Ben Example');
  assert.equal(sign.wayCount, 2);
  assert.deepEqual(
    plan.ways.map((w) => [w.text, names.get(w.playerId), w.createdAt]),
    [
      ['5 − 3 = 2', 'Cal Example', '2005-03-08T12:40:00.000Z'],
      ['2 + 3 = 5', 'Ben Example', '2005-03-08T12:40:00.001Z']
    ]
  );
  assert.deepEqual(sign.firstWay, { text: '5 − 3 = 2', value: '2', playerId: plan.ways[0].playerId });
});

test('a fix corrects what the archive recorded', () => {
  const fixed: ArchiveSeed = {
    ...seed,
    fixes: {
      a: { way: '√144 = 12', numbers: ['12', '144'], coordinates: [1.5, 2.5], caption: null }
    }
  };
  const plan = buildArchivePlan(
    [post('a', 'Fixed', 'Ben Example', { numbers: ['twelve'], math: ['nonsense'] })],
    fixed
  );
  const [sign] = plan.signs;
  assert.equal(sign.firstWay?.text, '√144 = 12');
  assert.deepEqual(sign.place, { label: 'Testville, Minnesota', state: 'MN', lat: 1.5, lng: 2.5, approximate: false });
  assert.equal(sign.caption, undefined);
});

test('a photo swap loads the better copy from the sign’s own photo', () => {
  const swapped = { ...seed, photo_swaps: { 'a.jpg': 'cleaned/a.jpg' } };
  const plan = buildArchivePlan([post('a', 'Trimmed', 'Ben Example'), post('b', 'Left', 'Ben Example')], swapped);
  assert.deepEqual(
    plan.photos.map((p) => p.source),
    ['cleaned/a.jpg', 'b.jpg']
  );
});

test('places read as the game wants them', () => {
  const dc = post('a', 'Capital', 'Ben Example', {
    location: { city: 'Washington', state: 'Washington, D.C.', country: 'United States', coordinates: [38.9, -77] }
  });
  const abroad = post('b', 'Abroad', 'Ben Example', {
    location: { city: 'Tel Aviv', state: 'None', country: 'Israel', coordinates: [32.04, 34.75] }
  });
  const places = new Map(buildArchivePlan([dc, abroad], seed).signs.map((s) => [s.title, s.place]));
  assert.equal(places.get('Capital')?.state, 'DC');
  assert.equal(places.get('Abroad')?.label, 'Tel Aviv, Israel');
  assert.equal(places.get('Abroad')?.state, undefined);
});

test('ids stay the same whatever else loads, so a later batch adds to this one', () => {
  const alone = buildArchivePlan([post('b', 'Later', 'Ben Example')], seed);
  const both = buildArchivePlan([post('b', 'Later', 'Ben Example'), post('c', 'Earlier', 'Ben Example')], seed);
  const later = both.signs.find((s) => s.title === 'Later')!;
  assert.equal(later.id, alone.signs[0].id);
  assert.equal(later.postedBy, alone.signs[0].postedBy);
  assert.equal(later.photos[0].id, alone.signs[0].photos[0].id);
  // Their first post sets when they joined: the older sign here.
  assert.equal(both.players[0].player.createdAt, '2005-01-02T17:00:00.000Z');
});

test('nothing in a plan holds an address', () => {
  const plan = buildArchivePlan([post('a', 'Keeps', 'Ben Example')], seed);
  assert.equal(plan.players[0].player.email, undefined);
});

const planned = (): ArchivePlan['players'] =>
  buildArchivePlan(
    [
      post('a', 'One', 'Ben Example', { found_by_user: 'Bexample' }),
      post('b', 'Two', 'Cal Example', { found_by_user: 'Cal' }),
      post('c', 'Three', 'Ada Example')
    ],
    seed
  ).players;

test('an old address links by full name, then by username, and one per player', () => {
  const linked = linkEmails(planned(), [
    { keys: ['BEN EXAMPLE '], email: 'Ben@Example.COM' },
    { keys: ['Bexample'], email: 'older@example.com' },
    { keys: ['cal'], email: 'cal@example.com' }
  ]);
  assert.equal(linked.emails.get('Ben Example'), 'ben@example.com');
  assert.equal(linked.emails.get('Cal Example'), 'cal@example.com');
  assert.deepEqual(linked.unmatched, []);
});

test('a second address for the same full name stays unlinked and is counted', () => {
  const linked = linkEmails(planned(), [
    { keys: ['Ben Example'], email: 'new@example.com' },
    { keys: ['Ben Example'], email: 'old@example.com' }
  ]);
  assert.equal(linked.emails.get('Ben Example'), 'new@example.com');
  assert.equal(linked.extra, 1);
  assert.deepEqual(linked.unmatched, ['Cal Example']);
});

test('an address that two players match goes to neither, and a player already in the game gets none', () => {
  const linked = linkEmails(planned(), [
    { keys: ['Ben Example', 'Cal Example'], email: 'both@example.com' },
    { keys: ['Ada Example'], email: 'ada@example.com' }
  ]);
  assert.equal(linked.emails.size, 0);
  assert.deepEqual(linked.shared.sort(), ['Ben Example', 'Cal Example']);
});

async function photoBytes(): Promise<Buffer> {
  return sharp({ create: { width: 700, height: 500, channels: 3, background: '#006348' } })
    .jpeg()
    .toBuffer();
}

/** A store with Ada, who is already playing, and a photo store that counts its uploads. */
async function loadSetup() {
  const store = new MemoryStore();
  await addPlayer(store, {
    id: '01ADA000000000000000000000',
    handle: 'ada',
    name: 'Ada',
    avatarColor: '#006348',
    createdAt: '2021-01-01T00:00:00.000Z'
  });
  const bytes = await photoBytes();
  const stored: string[] = [];
  const photos = new MemoryPhotoStore();
  const putUpload = photos.putUpload.bind(photos);
  photos.putUpload = async (id, sized) => {
    stored.push(id);
    await putUpload(id, sized);
  };
  return { store, photos, read: async () => bytes, stored };
}

test('a load writes signs in the past, with sized photos, under the right players', async () => {
  const deps = await loadSetup();
  const plan = buildArchivePlan([post('a', 'Oldest', 'Ben Example'), post('c', 'Ada Sign', 'Ada Example')], seed);
  const report = await loadArchive(plan, deps);
  assert.deepEqual(report, { added: 2, alreadyThere: 0, playersAdded: 1, creditedToExisting: [] });
  const signs = await deps.store.allSigns();
  const oldest = signs.find((s) => s.title === 'Oldest')!;
  assert.equal(oldest.postedAt, '2005-03-08T12:40:00.000Z');
  assert.equal(oldest.photos[0].width, 700);
  assert.equal((await deps.store.listWays(oldest.id))[0].createdAt, oldest.postedAt);
  assert.equal(signs.find((s) => s.title === 'Ada Sign')!.postedBy, '01ADA000000000000000000000');
  assert.equal(signs.find((s) => s.title === 'Ada Sign')!.finders[0].name, 'Ada');
});

test('a second load writes nothing', async () => {
  const deps = await loadSetup();
  const plan = buildArchivePlan([post('a', 'Oldest', 'Ben Example')], seed);
  await loadArchive(plan, deps);
  const before = JSON.stringify(deps.store.snapshot());
  const photosBefore = deps.stored.length;
  const again = await loadArchive(buildArchivePlan([post('a', 'Oldest', 'Ben Example')], seed), deps);
  assert.deepEqual(again, { added: 0, alreadyThere: 1, playersAdded: 0, creditedToExisting: [] });
  assert.equal(JSON.stringify(deps.store.snapshot()), before);
  assert.equal(deps.stored.length, photosBefore);
});

test('today’s players keep their slugs and handles; old ones move aside', async () => {
  const deps = await loadSetup();
  await addSign(deps.store, {
    ...buildArchivePlan([post('b', 'Genesis', 'Ada Example')], seed).signs[0],
    id: '01TODAY0000000000000000000',
    postedBy: '01ADA000000000000000000000',
    photos: []
  });
  await addPlayer(deps.store, {
    id: '01BEN000000000000000000000',
    handle: 'ben-example',
    name: 'Someone Else',
    avatarColor: '#006348',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  await loadArchive(buildArchivePlan([post('a', 'Genesis', 'Ben Example')], seed), deps);
  const old = (await deps.store.allSigns()).find((s) => s.postedAt.startsWith('2005'))!;
  assert.equal(old.slug, 'genesis-2');
  const players = await deps.store.allPlayers();
  assert.ok(players.some((p) => p.name === 'Ben Example' && p.handle === 'ben-example-2'));
});

test('an old address claims the player: the first sign-in finds the signs waiting', async () => {
  const deps = await loadSetup();
  const plan = buildArchivePlan([post('a', 'Oldest', 'Ben Example')], seed);
  await loadArchive(plan, deps, new Map([['Ben Example', 'ben@example.com']]));
  const owner = await deps.store.playerIdForEmail('BEN@example.com');
  assert.equal(owner, plan.signs[0].postedBy);
  assert.equal((await deps.store.getPlayer(owner!))?.email, 'ben@example.com');
});

test('a player already playing under the old address gets the signs on that account', async () => {
  const deps = await loadSetup();
  await addPlayer(deps.store, {
    id: '01BEN000000000000000000000',
    handle: 'bennie',
    name: 'Bennie',
    avatarColor: '#006348',
    email: 'ben@example.com',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  const plan = buildArchivePlan([post('a', 'Oldest', 'Ben Example')], seed);
  const report = await loadArchive(plan, deps, new Map([['Ben Example', 'ben@example.com']]));
  assert.deepEqual(report.creditedToExisting, ['Ben Example']);
  const [sign] = (await deps.store.allSigns()).filter((s) => s.title === 'Oldest');
  assert.equal(sign.postedBy, '01BEN000000000000000000000');
  assert.equal(sign.finders[0].name, 'Bennie');
  assert.equal((await deps.store.listWays(sign.id))[0].playerId, '01BEN000000000000000000000');
  assert.equal((await deps.store.allPlayers()).length, 2);
});

test('a load before the launch signs says so', async () => {
  const plan = buildArchivePlan([post('c', 'Ada Sign', 'Ada Example')], seed);
  const deps = await loadSetup();
  await assert.rejects(
    loadArchive(plan, { ...deps, store: new MemoryStore() }),
    /No player @ada: load the launch signs first/
  );
});

// The real file: what can be proved without the archive itself.
const real = JSON.parse(await readFile('seed/archive.json', 'utf8')) as ArchiveSeed;

test('every date in the real file is in the old site’s years and no sign is found after its post', () => {
  const entries = Object.entries(real.dates);
  assert.equal(entries.length, 251);
  for (const [stem, { posted_at, found_on }] of entries) {
    const time = Date.parse(posted_at);
    assert.ok(time >= Date.parse('2005-01-01') && time < Date.parse('2015-01-01'), stem);
    assert.match(found_on, /^\d{4}-\d{2}-\d{2}$/, stem);
    const day = new Date(time).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    assert.ok(found_on <= day, `${stem}: found ${found_on}, posted ${day}`);
  }
});

test('the real file has the dates the photos prove', () => {
  const genesis = real.dates['2005-03-06-genesis'];
  assert.equal(genesis.found_on, '2005-03-07');
  assert.equal(genesis.posted_at, '2005-03-08T12:40:00.000Z');
  assert.equal(real.dates['2005-04-16-blackjack'].found_on, '2005-03-28');
});

test('every way written by hand in the real file passes the checker on its own sign', () => {
  for (const [stem, fix] of Object.entries(real.fixes)) {
    if (!fix.way) continue;
    const result = check(tidyWay(fix.way));
    assert.ok(result.ok, `${stem}: ${fix.way}`);
    if (fix.numbers) assert.deepEqual(numbersNotOnSign(result.numbers, fix.numbers), [], stem);
  }
});

test('the real file holds no address and no path', async () => {
  const text = await readFile('seed/archive.json', 'utf8');
  assert.doesNotMatch(text, /@|\/Users\//);
});
