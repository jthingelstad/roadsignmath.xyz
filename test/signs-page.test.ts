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
        postedAt: new Date(Date.UTC(2023, 0, 1 + n)).toISOString()
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
  return { page, app };
}

/** The sign titles on a page, in the order they appear on cards. */
const titles = (html: string): string[] =>
  [...html.matchAll(/<li class="tile"[^>]*>.*?<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);

test('/signs lists every shown sign, newest first, grouped by the year it was found', async () => {
  const { page } = await setup();
  const { res, html } = await page('/signs');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60, s-maxage=86400');
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
  // A sort the page doesn't know goes to Latest with a 301 (below).
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

test('Home shows the twelve newest signs; its sorts open the Signs page', async () => {
  const { page, app } = await setup(10);
  const home = (await page('/')).html;
  assert.equal(titles(home).length, 12);
  assert.match(home, /<a class="all" href="\/signs">All 14 signs<\/a>/);
  assert.match(home, /<a class="chip" href="\/signs\?sort=popular" data-sort="popular">Popular<\/a>/);
  // An old link to a sorted Home goes to the Signs page in that sort.
  const res = await app.request('/?sort=complexity');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/signs?sort=complexity');
  assert.equal((await app.request('/?sort=latest')).status, 200);
});

test('the sitemap lists /signs', async () => {
  const { page } = await setup();
  assert.match((await page('/sitemap.xml')).html, /<loc>https:\/\/example\.test\/signs<\/loc><lastmod>/);
});

test('/signs draws 48 cards a page, with a Show more link to the next that works without script', async () => {
  const { page } = await setup(60);
  const first = (await page('/signs')).html;
  assert.equal(titles(first).length, 48);
  assert.match(first, /<a class="more" href="\/signs\?page=2" rel="next">Show more<\/a>/);
  assert.match(first, /<nav class="pager" aria-label="More signs" data-total="64">/);
  assert.ok(first.includes('Showing 48 of 64 signs'));
  // The year's count is every sign found that year, not only the ones on this page.
  assert.match(first, /<h2 id="y2026">2026<\/h2><span>61 signs<\/span>/);
  assert.match(first, /<link rel="canonical" href="https:\/\/example.test\/signs"\/>/);
  const second = await page('/signs?page=2');
  assert.equal(second.res.status, 200);
  assert.equal(titles(second.html).length, 16);
  // Between them, every sign once.
  assert.equal(new Set([...titles(first), ...titles(second.html)]).size, 64);
  assert.ok(!second.html.includes('class="more"'));
  assert.ok(second.html.includes('Signs 49–64 of 64'));
  assert.ok(second.html.includes('<title>Every sign (page 2) · Road Sign Math</title>'));
  assert.match(second.html, /<link rel="canonical" href="https:\/\/example.test\/signs\?page=2"\/>/);
  assert.match(second.html, /<a href="\/signs">Back to the first page<\/a>/);
  // A sort keeps its paging and the link keeps the sort.
  const popular = (await page('/signs?sort=popular')).html;
  assert.equal(titles(popular).length, 48);
  assert.match(popular, /<a class="more" href="\/signs\?sort=popular&amp;page=2" rel="next">/);
  // Nearby draws every card for the browser to sort, shown 48 at a time by script.
  const near = (await page('/signs?sort=nearby')).html;
  assert.equal(titles(near).length, 64);
  assert.ok(!near.includes('class="more"'));
  assert.match(near, /<button type="button" class="nearby-more" hidden="">Show more<\/button>/);
  assert.ok(near.includes('let shown = 48;'));
});

test('/signs sends a choice it does not know to the page without it, with a 301', async () => {
  const { app } = await setup(60);
  const to = async (path: string) => {
    const res = await app.request(path);
    return [res.status, res.headers.get('location'), res.headers.get('cache-control')];
  };
  const day = 'public, max-age=60, s-maxage=86400';
  assert.deepEqual(await to('/signs?sort=random'), [301, '/signs', day]);
  assert.deepEqual(await to('/signs?sort=popular&year=1999'), [301, '/signs?sort=popular', day]);
  assert.deepEqual(await to('/signs?year=2025&state=ZZ'), [301, '/signs?year=2025', day]);
  assert.deepEqual(await to('/signs?page=1'), [301, '/signs', day]);
  assert.deepEqual(await to('/signs?page=3'), [301, '/signs', day]);
  assert.deepEqual(await to('/signs?page=two'), [301, '/signs', day]);
  assert.deepEqual(await to('/signs?sort=nearby&page=2'), [301, '/signs?sort=nearby', day]);
  // A state in lower case, and the state menu's empty "All states", are fine as they are.
  assert.equal((await app.request('/signs?state=mn')).status, 200);
  assert.equal((await app.request('/signs?state=')).status, 200);
});

test('a filtered /signs names plain /signs as canonical; the filters fold on a phone', async () => {
  const { page } = await setup();
  for (const path of ['/signs?sort=complexity', '/signs?year=2025', '/signs?state=IA']) {
    assert.match((await page(path)).html, /<link rel="canonical" href="https:\/\/example.test\/signs"\/>/, path);
  }
  const html = (await page('/signs?sort=popular&year=2025')).html;
  assert.match(html, /<details class="filterbox" open="">/);
  assert.match(html, /<span class="now">Popular, 2025, All states<\/span>/);
  assert.ok(html.includes("matchMedia('(max-width: 699px)')"));
  // Nearby's button is in the box, so the box stays open for it; a filter says how many it left.
  assert.ok(html.includes("!narrow.matches || !!box.querySelector('.locate')"));
  assert.match(html, /<p class="lead">[^,]*\d+ signs? of \d+</);
  assert.match(
    (await page('/signs?sort=popular')).html,
    /<p class="lead">[^,]*\d+ signs? from \d+ players? in \d+ states?</
  );
  // The years sit in one row that scrolls sideways on a phone.
  assert.match(html, /<div class="chips yearchips" role="group" aria-label="Year found">/);
  assert.match(html, /\.filters \.yearchips \{ flex-wrap: nowrap; overflow-x: auto;/);
});

test('/signs has a search box for script, over every sign in /signs.json, with no query parameter', async () => {
  const { page } = await setup(60);
  const html = (await page('/signs')).html;
  // The box is no form field: nothing it holds goes in an address.
  assert.match(html, /<input id="find" type="search" autocomplete="off"/);
  assert.ok(!/<input id="find"[^>]*name=/.test(html));
  assert.ok(html.includes("get('/signs.json', 'json')"));
  // Its cards are the pages' own, math drawn on the server: it knows how many plain pages there are.
  assert.match(html, /<div class="search" role="search" data-pages="2" hidden="">/);
  assert.ok(html.includes('function rsmSignMatches(sign, query)'));
});
