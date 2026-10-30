import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renditions } from '../src/photos.ts';
import { buildPlan, captionOf, imagesOf, type FeedItem, type SeedFile } from '../src/seed/microblog.ts';

const fictional: SeedFile = {
  posted_by: 'ada',
  players: [
    { handle: 'ada', name: 'Ada', avatar_color: '#006348', bio: 'Counts everything.' },
    { handle: 'ben', name: 'Ben', avatar_color: '#004C80' }
  ],
  signs: [
    {
      post: '2026/01/10/testville.html',
      title: 'Testville',
      finder: 'ada',
      math: '7 + 12 = 19',
      numbers: [{ value: '7', text: 'Northtown 7' }, { value: '12' }, { value: '19' }],
      place: { label: 'Near Testville, Minnesota', state: 'MN', lat: 44.9, lng: -93.2 },
      alt: ['A green sign: Northtown 7, Southtown 12, Testville 19.']
    },
    {
      post: '2026/02/01/two-photos.html',
      title: 'Two Photos',
      finder: 'ben',
      math: '√(5 − 1) = 2',
      numbers: [{ value: '2', text: 'EXIT 2' }, { value: '5' }, { value: '1' }],
      place: { label: 'Along a highway' },
      alt: ['The sign.', 'The sign from further back.']
    }
  ]
};

/** A stand-in export with one post per seeded sign. */
function feedFor(file: SeedFile): FeedItem[] {
  return file.signs.map((s, i) => ({
    url: `https://blog.example/${s.post}`,
    content_text: s.alt.map((_, j) => `<img src="uploads/${i}-${j}.jpg" alt="">`).join('\n\n'),
    date_published: `2026-01-${String(10 + i).padStart(2, '0')}T12:00:00-06:00`
  }));
}

test('a plan has players, signs, ways and photos, checked and credited', () => {
  const plan = buildPlan(feedFor(fictional), fictional);
  assert.deepEqual(
    plan.signs.map((s) => [s.slug, s.firstWay?.text, s.finders[0].name, s.photos.length, s.place.approximate]),
    [
      ['testville', '7 + 12 = 19', 'Ada', 1, true],
      ['two-photos', '√(5 − 1) = 2', 'Ben', 2, true]
    ]
  );
  const ada = plan.players.find((p) => p.handle === 'ada')!;
  assert.ok(plan.signs.every((s) => s.postedBy === ada.id));
  assert.equal(plan.signs[1].foundOn, '2026-01-11');
  assert.equal(plan.signs[1].postedAt, '2026-01-11T18:00:00.000Z');
  assert.deepEqual(
    plan.ways.map((w) => [w.text, w.numbers]),
    [
      ['7 + 12 = 19', ['7', '12', '19']],
      ['√(5 − 1) = 2', ['5', '1', '2']]
    ]
  );
  assert.equal(plan.photos.length, 3);
});

test('the plan is the same every run', () => {
  assert.deepEqual(buildPlan(feedFor(fictional), fictional), buildPlan(feedFor(fictional), fictional));
});

test('seed/microblog.json is well formed: every way true, every number on its sign', async () => {
  // Checks the committed launch set as data; it names no one here.
  const launch = JSON.parse(await readFile('seed/microblog.json', 'utf8')) as SeedFile;
  const plan = buildPlan(feedFor(launch), launch);
  assert.equal(plan.signs.length, launch.signs.length);
  assert.equal(new Set(plan.signs.map((s) => s.slug)).size, plan.signs.length);
  assert.ok(plan.signs.every((s) => s.finders.every((f) => f.playerId)));
});

test('captions keep the words and drop the math, images and link targets', () => {
  const text =
    '[Ada](https://ada.example) found this **great** one.\n\n$$ 1 + 1 = 2 $$\n\n<img src="uploads/a.jpg" alt="">\n\nSecond   line.\n';
  assert.equal(captionOf(text), 'Ada found this great one.\n\nSecond line.');
  assert.equal(captionOf('$$ 1 = 1 $$\n\n<img src="x.jpg">'), undefined);
  assert.deepEqual(imagesOf(text), ['uploads/a.jpg']);
});

test('a seed that does not fit the export says why', () => {
  const bad: SeedFile = {
    posted_by: 'ada',
    players: [{ handle: 'ada', name: 'Ada', avatar_color: '#006348' }],
    signs: [
      {
        post: 'a.html',
        title: 'A',
        finder: 'ada',
        math: '7 + 12 = 19',
        numbers: [{ value: '7' }, { value: '12' }],
        place: { label: 'Testville' },
        alt: ['x']
      },
      { post: 'gone.html', title: 'B', finder: 'bob', math: '1 = 1', numbers: [], place: { label: 'X' }, alt: [] }
    ]
  };
  const feed: FeedItem[] = [
    { url: 'https://blog.example/a.html', content_text: '', date_published: '2026-01-01T00:00:00Z' },
    { url: 'https://blog.example/extra.html', content_text: '', date_published: '2026-01-02T00:00:00Z' }
  ];
  assert.throws(
    () => buildPlan(feed, bad),
    (err: Error) =>
      /19 not among the sign's numbers/.test(err.message) &&
      /0 photos but 1 alt texts/.test(err.message) &&
      /gone.html: not in the export/.test(err.message) &&
      /extra.html: in the export but not seeded/.test(err.message)
  );
});

test('photos come out at two sizes with no metadata', async () => {
  const original = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#006348' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'test' } })
    .toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const out = await renditions(original);
  assert.deepEqual([out.width, out.height], [1600, 1067]);
  const large = await sharp(out.large).metadata();
  const thumb = await sharp(out.thumb).metadata();
  assert.equal(large.exif, undefined);
  assert.equal(thumb.width, 480);
  assert.equal(large.format, 'jpeg');
});
