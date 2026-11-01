import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { cardUrl, cardVersion, homeCard, playerCard, signCard } from '../src/web/share.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await addPlayer(store, ben);
  await store.putSign(sign({ id: '01JS0000000000000000000001', title: 'Open Sign', firstWay: undefined, wayCount: 0 }));
  await store.putSign(sign({ id: '01JS0000000000000000000002', title: 'Solved Sign' }));
  await store.addWay(
    way('01JS0000000000000000000002', { text: '7 + 12 = 19', value: '19', numbers: ['7', '12', '19'] })
  );
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  return { app, store };
}

const page = async (app: Awaited<ReturnType<typeof setup>>['app'], path: string) => (await app.request(path)).text();
/** The values of a page's <data class="name"> elements (all hidden: fields, never layout). */
const data = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`<data hidden="" class="${name}" value="([^"]*)"`, 'g'))].map((m) => m[1]);
/** Every <data> on the page is hidden, so the fields never shift what readers see. */
const allHidden = (html: string) => (html.match(/<data\b[^>]*>/g) ?? []).every((tag) => /\shidden(=""|\s|>)/.test(tag));
const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

test('a card’s v is a short hash of what it shows, and its path is the page’s', () => {
  assert.match(cardVersion(['a', 1]), /^[0-9a-f]{10}$/);
  assert.equal(cardVersion(['a', 1]), cardVersion(['a', 1]));
  assert.notEqual(cardVersion(['a', 1]), cardVersion(['a', 2]));
  assert.match(cardUrl('/signs/x', []), /^https:\/\/cards\.thingelstad\.com\/rsm\/signs\/x\.png\?v=[0-9a-f]{10}$/);
  assert.match(cardUrl('/', []), /^https:\/\/cards\.thingelstad\.com\/rsm\/index\.png\?v=/);
});

test('a card’s alt text says what it shows', () => {
  const base = { path: '/signs/x', title: 'X', photo: null, place: 'Near Y, Iowa', foundOn: '2026-01-10', wayCount: 1 };
  assert.equal(
    signCard({ ...base, finders: ['Ada', 'Ben'], way: { text: '1 + 1 = 2', tex: '1 + 1 = 2' }, numbers: ['1', '2'] })
      .alt,
    'X: 1 + 1 = 2. Found by Ada and Ben. Near Y, Iowa.'
  );
  assert.equal(
    signCard({ ...base, finders: [], way: null, wayCount: 0, numbers: ['7', '12', '19'] }).alt,
    'X, not solved yet: the numbers 7, 12 and 19. Near Y, Iowa.'
  );
  const player = { path: '/players/ada', name: 'Ada', photo: null, color: '#006348', firstYear: 2026 };
  assert.equal(
    playerCard({ ...player, signCount: 1, stateCount: 1 }).alt,
    'Ada on Road Sign Math: 1 sign found in 1 state since 2026.'
  );
  assert.equal(
    homeCard({ signCount: 2, playerCount: 1, stateCount: 1, pins: [] }).alt,
    'Road Sign Math: a map of the United States with a pin for each of the 2 signs players have found.'
  );
});

test('a sign page is an h-entry with what its card shows, and names its card', async () => {
  const { app, store } = await setup();
  const html = await page(app, '/signs/solved-sign');
  assert.match(html, /<main id="main" class="sign h-entry">/);
  assert.match(html, /<h1 class="p-name">Solved Sign<\/h1>/);
  assert.match(html, /<time class="dt-published" datetime="2026-01-10">/);
  assert.deepEqual(data(html, 'u-url'), ['https://example.test/signs/solved-sign']);
  assert.deepEqual(data(html, 'u-photo'), ['https://example.test/p/ph-01JS0000000000000000000002/large.jpg']);
  assert.deepEqual(data(html, 'p-location'), ['Testville, Minnesota']);
  assert.deepEqual(data(html, 'p-finder'), ['Ada']);
  assert.deepEqual(data(html, 'p-math'), ['7 + 12 = 19']);
  assert.equal(data(html, 'p-tex').length, 1);
  assert.deepEqual(data(html, 'p-way-count'), ['1']);
  assert.deepEqual(data(html, 'p-number'), ['7', '12', '19']);
  const image = meta(html, 'og:image');
  assert.match(image ?? '', /^https:\/\/cards\.thingelstad\.com\/rsm\/signs\/solved-sign\.png\?v=[0-9a-f]{10}$/);
  assert.equal(meta(html, 'twitter:image'), image);
  assert.equal(meta(html, 'og:image:width'), '1200');
  assert.equal(meta(html, 'og:image:height'), '630');
  assert.equal(meta(html, 'og:image:alt'), 'Solved Sign: 7 + 12 = 19. Found by Ada. Testville, Minnesota.');
  assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
  assert.ok(allHidden(html));
  // Another way is a new card.
  await store.addWay(
    way('01JS0000000000000000000002', {
      id: 'way-2',
      text: '19 − 12 = 7',
      value: '7',
      numbers: ['19', '12', '7'],
      playerId: ben.id
    })
  );
  const after = await page(app, '/signs/solved-sign');
  assert.deepEqual(data(after, 'p-way-count'), ['2']);
  assert.notEqual(meta(after, 'og:image'), image);
});

test('an unsolved sign publishes its numbers and no math', async () => {
  const { app } = await setup();
  const html = await page(app, '/signs/open-sign');
  assert.deepEqual(data(html, 'p-math'), []);
  assert.deepEqual(data(html, 'p-tex'), []);
  assert.deepEqual(data(html, 'p-way-count'), ['0']);
  assert.deepEqual(data(html, 'p-number'), ['7', '12', '19']);
  assert.match(meta(html, 'og:image:alt') ?? '', /not solved yet: the numbers 7, 12 and 19/);
});

test('a player page is an h-card with its own u-url, and its card is their photo or their letter', async () => {
  const { app, store } = await setup();
  const html = await page(app, '/players/ada');
  assert.match(html, /class="who-is h-card"/);
  assert.deepEqual(data(html, 'u-url'), ['https://example.test/players/ada']);
  assert.deepEqual(data(html, 'u-photo'), []);
  assert.deepEqual(data(html, 'p-avatar-color'), ['#006348']);
  assert.deepEqual(data(html, 'p-sign-count'), ['2']);
  assert.deepEqual(data(html, 'p-state-count'), ['1']);
  assert.deepEqual(data(html, 'p-first-year'), ['2026']);
  assert.match(html, /class="p-name"[^>]*>Ada</);
  // The fields sit inside the header's flex row; hidden, they take no gap.
  assert.ok(allHidden(html));
  const letter = meta(html, 'og:image');
  assert.match(letter ?? '', /^https:\/\/cards\.thingelstad\.com\/rsm\/players\/ada\.png\?v=[0-9a-f]{10}$/);
  // Never the player's email, anywhere on the page.
  assert.ok(!html.includes(ada.email!));
  await store.setAvatar(ada.id, 'face1');
  const face = await page(app, '/players/ada');
  assert.deepEqual(data(face, 'u-photo'), ['https://example.test/p/face1/large.jpg']);
  assert.notEqual(meta(face, 'og:image'), letter);
});

test('home is an h-feed with the map and a pin for every place, and names its card', async () => {
  const { app } = await setup();
  const html = await page(app, '/');
  assert.match(html, /class="hero h-feed"/);
  assert.deepEqual(data(html, 'p-name'), ['Road Sign Math']);
  assert.deepEqual(data(html, 'u-map'), ['https://example.test/us-map.svg']);
  const pins = data(html, 'p-pin');
  assert.equal(pins.length, 1);
  assert.match(pins[0], /^\d+\.\d{2} \d+\.\d{2} 2$/);
  assert.match(html, /class="kicker mono p-kicker"/);
  assert.ok(allHidden(html));
  assert.match(html, /<dd class="mono p-sign-count">2<\/dd>/);
  assert.match(meta(html, 'og:image') ?? '', /^https:\/\/cards\.thingelstad\.com\/rsm\/index\.png\?v=[0-9a-f]{10}$/);
  // The same card whatever year the page is filtered to.
  assert.equal(meta(await page(app, '/?year=2025'), 'og:image'), meta(html, 'og:image'));
});
