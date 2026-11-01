import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { ada, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { FakeTinylytics } from './support/tinylytics.ts';

const id = (n: number) => `01JS${String(n).padStart(22, '0')}`;

/** Signs in order of posting: Plain (2024, MN), Root (2025, MN), Fraction (2025, IA), Unsolved (2026, IA). */
async function setup(extra = 0) {
  const store = new MemoryStore();
  const tinylytics = new FakeTinylytics();
  await addPlayer(store, ada);
  const place = (state: string, lat: number, lng: number) => ({
    label: `A town, ${state}`,
    state,
    lat,
    lng,
    approximate: true
  });
  await addSign(
    store,
    sign({
      id: id(1),
      title: 'Plain',
      foundOn: '2024-05-01',
      postedAt: '2024-05-01T00:00:00.000Z',
      place: place('MN', 45, -93)
    })
  );
  await addSign(
    store,
    sign({
      id: id(2),
      title: 'Root',
      foundOn: '2025-05-01',
      postedAt: '2025-05-01T00:00:00.000Z',
      place: place('MN', 46, -94)
    })
  );
  await addSign(
    store,
    sign({
      id: id(3),
      title: 'Fraction',
      foundOn: '2025-06-01',
      postedAt: '2025-06-01T00:00:00.000Z',
      place: place('IA', 42, -91)
    })
  );
  await addSign(
    store,
    sign({
      id: id(4),
      title: 'Unsolved',
      foundOn: '2026-01-01',
      postedAt: '2026-01-01T00:00:00.000Z',
      place: place('IA', 41, -92),
      firstWay: undefined,
      wayCount: 0
    })
  );
  await addSign(store, sign({ id: id(5), title: 'Held', visibility: 'held' }));
  for (let n = 0; n < extra; n++) {
    await addSign(
      store,
      sign({
        id: id(100 + n),
        title: `Extra ${n}`,
        postedAt: `2023-01-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`
      })
    );
  }
  await store.addWay(way(id(1), { id: 'W1', text: '7 + 12 = 19' }));
  await store.addWay(way(id(2), { id: 'W2', text: '√(7 + 12 − 19 + 4) = 2', value: '2' }));
  await store.addWay(way(id(3), { id: 'W3', text: '12 ÷ (19 − 7) = 1', value: '1' }));
  tinylytics.kudosKept.push(
    { path: '/signs/plain', uid: 'a' },
    { path: '/signs/plain', uid: 'b' },
    { path: '/signs/fraction', uid: 'c' }
  );
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    tinylytics
  });
  const page = async (path: string) => {
    const res = await app.request(path);
    return { res, html: await res.text() };
  };
  return { page };
}

/** The sign titles on a page, in the order they appear on cards. */
const titles = (html: string): string[] =>
  [...html.matchAll(/<li class="tile"[^>]*>.*?<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);

test('/signs lists every shown sign, newest first, grouped by the year it was found', async () => {
  const { page } = await setup();
  const { res, html } = await page('/signs');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(titles(html), ['Unsolved', 'Fraction', 'Root', 'Plain']);
  assert.ok(html.indexOf('<h2 id="y2026">2026</h2>') < html.indexOf('<h2 id="y2025">2025</h2>'));
  assert.match(html, /<a href="\/signs" aria-current="page">Signs<\/a>/);
  assert.match(html, /<a class="chip" href="\/signs" aria-current="true" data-sort="latest">Latest<\/a>/);
  assert.ok(!html.includes('Held'));
});

test('/signs sorts the way the app does: Popular by hearts, Complexity by the math', async () => {
  const { page } = await setup();
  assert.deepEqual(titles((await page('/signs?sort=popular')).html), ['Plain', 'Fraction', 'Unsolved', 'Root']);
  // Root's √ and three + or − (7 in all) beats Fraction's ÷ and − (4), then + (1); unsolved last.
  assert.deepEqual(titles((await page('/signs?sort=complexity')).html), ['Root', 'Fraction', 'Plain', 'Unsolved']);
  // Nearby starts newest first with every card's pin, and asks the browser only on a tap.
  const near = (await page('/signs?sort=nearby')).html;
  assert.deepEqual(titles(near), ['Unsolved', 'Fraction', 'Root', 'Plain']);
  assert.match(near, /<li class="tile" data-lat="45" data-lng="-93">/);
  assert.match(near, /<button type="button" class="locate" hidden="">Use my location<\/button>/);
  assert.ok(near.includes('navigator.geolocation'));
  // Anything else is Latest.
  assert.deepEqual(titles((await page('/signs?sort=random')).html), ['Unsolved', 'Fraction', 'Root', 'Plain']);
});

test('/signs filters by year and state, and every link keeps the other choices', async () => {
  const { page } = await setup();
  const html = (await page('/signs?sort=complexity&year=2025&state=mn')).html;
  assert.deepEqual(titles(html), ['Root']);
  assert.ok(html.includes('<h1>Signs: Minnesota, 2025</h1>'));
  assert.match(html, /<a class="chip" href="\/signs\?sort=popular&amp;year=2025&amp;state=MN"/);
  // Each filter counts within the other: Minnesota has one sign from 2025, 2025 has one in Minnesota.
  assert.match(html, /<option value="MN" selected="">Minnesota \(1\)<\/option>/);
  assert.match(html, /<option value="IA">Iowa \(1\)<\/option>/);
  assert.match(html, /aria-current="true">2025<span class="sep"><span class="vh">, <\/span><\/span>1<\/a>/);
  // 2026 has nothing in Minnesota, so it isn't offered there.
  assert.ok(!html.includes('href="/signs?sort=complexity&amp;year=2026&amp;state=MN"'));
  assert.match(html, /<input type="hidden" name="sort" value="complexity"\/>/);
  const none = (await page('/signs?year=2024&state=IA')).html;
  assert.deepEqual(titles(none), []);
  assert.ok(none.includes('No signs match yet.'));
});

test('Home shows twelve signs in the chosen sort, then a link to all of them', async () => {
  const { page } = await setup(10);
  const home = (await page('/')).html;
  assert.equal(titles(home).length, 12);
  assert.match(home, /<a class="all" href="\/signs">All 14 signs<\/a>/);
  assert.match(home, /<a class="chip" href="\/\?sort=popular#signs" data-sort="popular">Popular<\/a>/);
  const complex = (await page('/?sort=complexity')).html;
  assert.deepEqual(titles(complex).slice(0, 2), ['Root', 'Fraction']);
  assert.match(complex, /<a class="all" href="\/signs\?sort=complexity">All 14 signs<\/a>/);
  // Nearby lists every sign so the browser can bring the closest up; past twelve wait hidden.
  const near = (await page('/?sort=nearby')).html;
  assert.equal(titles(near).length, 14);
  assert.equal((near.match(/<li class="tile" hidden=""/g) ?? []).length, 2);
});

test('the sitemap lists /signs', async () => {
  const { page } = await setup();
  assert.match((await page('/sitemap.xml')).html, /<loc>https:\/\/example\.test\/signs<\/loc><lastmod>/);
});
