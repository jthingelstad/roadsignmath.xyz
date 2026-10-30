import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renditions } from '../src/photos.ts';
import { buildPlan, captionOf, imagesOf, type FeedItem, type SeedFile } from '../src/seed/microblog.ts';

const seed = JSON.parse(await readFile('seed/microblog.json', 'utf8')) as SeedFile;

/** A stand-in export with one post per seeded sign, so the seed can be checked without the real one. */
function feedFor(file: SeedFile): FeedItem[] {
  return file.signs.map((s, i) => ({
    url: `https://blog.example/${s.post}`,
    content_text: s.alt.map((_, j) => `<img src="uploads/${i}-${j}.jpg" alt="">`).join('\n\n'),
    date_published: `20${String(21 + (i % 5))}-0${1 + (i % 9)}-1${i % 10}T12:00:00-05:00`
  }));
}

test('the launch set: 16 signs, all true, every number on its sign', () => {
  const plan = buildPlan(feedFor(seed), seed);
  assert.equal(plan.signs.length, 16);
  assert.equal(plan.ways.length, 16);
  assert.equal(plan.photos.length, 17);
  const by = (handle: string) => plan.players.find((p) => p.handle === handle)!.id;
  const count = (handle: string) => plan.signs.filter((s) => s.finders[0].playerId === by(handle)).length;
  assert.deepEqual([count('jamie'), count('tyler'), count('tammy')], [13, 2, 1]);
  assert.equal(new Set(plan.signs.map((s) => s.slug)).size, 16);
  assert.equal(plan.signs.filter((s) => s.place.lat === undefined).length, 1, 'only Gross Vehicle Weight has no pin');
});

test('the plan is the same every run', () => {
  assert.deepEqual(buildPlan(feedFor(seed), seed), buildPlan(feedFor(seed), seed));
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
