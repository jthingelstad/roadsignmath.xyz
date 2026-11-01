import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { BETA_QR_FOR, BETA_QR_SVG } from '../src/web/app-assets.ts';
import { TESTFLIGHT_URL } from '../src/web/layout.tsx';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const cy: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cy',
  name: 'Cy',
  avatarColor: '#F2B300',
  createdAt: '2026-01-03T00:00:00.000Z'
};
const dee: Player = {
  id: '01JDDDDDDDDDDDDDDDDDDDDDDD',
  handle: 'dee',
  name: 'Dee',
  avatarColor: '#004C80',
  createdAt: '2026-01-04T00:00:00.000Z'
};
const id = (n: number) => `01JS${String(n).padStart(22, '0')}`;

/**
 * Ada (with a bio) found signs in 2024 and 2025, Ben one in 2025 and a held one in 2026, Cy has
 * only a way on Ada's sign (a badge, no sign), and Dee has nothing on the map.
 */
async function setup() {
  const store = new MemoryStore();
  for (const p of [ada, ben, cy, dee]) await addPlayer(store, p);
  const by = (p: Player) => ({ postedBy: p.id, finders: [{ playerId: p.id, name: p.name, role: 'found' as const }] });
  const place = (state: string) => ({ label: `A town, ${state}`, state, lat: 44, lng: -93, approximate: true });
  await addSign(
    store,
    sign({
      id: id(1),
      title: 'Ada Old',
      foundOn: '2024-03-01',
      postedAt: '2024-03-02T00:00:00.000Z',
      place: place('MN'),
      ...by(ada)
    })
  );
  await addSign(
    store,
    sign({
      id: id(2),
      title: 'Ada New',
      foundOn: '2025-06-01',
      postedAt: '2025-06-02T00:00:00.000Z',
      place: place('IA'),
      firstWay: { text: '18 ÷ 6 = 3', value: '3', playerId: ada.id },
      ...by(ada)
    })
  );
  await addSign(
    store,
    sign({
      id: id(3),
      title: 'Ben One',
      foundOn: '2025-01-01',
      postedAt: '2025-01-02T00:00:00.000Z',
      place: place('WI'),
      ...by(ben)
    })
  );
  await addSign(store, sign({ id: id(4), title: 'Ben Held', foundOn: '2026-01-01', visibility: 'held', ...by(ben) }));
  await store.addWay(way(id(1), { id: 'W1' }));
  await store.addWay(way(id(2), { id: 'W2', text: '18 ÷ 6 = 3', value: '3', numbers: ['18', '6', '3'] }));
  await store.addWay(way(id(3), { id: 'W3', playerId: ben.id }));
  await store.addWay(
    way(id(1), { id: 'W4', playerId: cy.id, text: '19 − 12 = 7', value: '7', createdAt: '2026-02-01T00:00:00.000Z' })
  );
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const page = async (path: string) => {
    const res = await app.request(path);
    return { res, html: await res.text() };
  };
  return { app, page };
}

const names = (html: string) =>
  [...html.matchAll(/<a class="pc" href="\/players\/[^"]+">.*?<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);

test('/players lists everyone with a sign or a badge, newest player first', async () => {
  const { page } = await setup();
  const { res, html } = await page('/players');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  // Cy started with a way in 2026, Ben with a sign in 2025, Ada in 2024; Dee has nothing yet.
  assert.deepEqual(names(html), ['Cy', 'Ben', 'Ada']);
  assert.match(html, /<a href="\/players" aria-current="page">Players<\/a>/);
  // A bio stands in for when they started.
  assert.match(html, /<h2>Ada<\/h2><span class="sub">Counts everything\.<\/span>/);
  assert.match(html, /<h2>Ben<\/h2><span class="sub">Playing since 2025<\/span>/);
  // Signs and states, never a count of badges; the held sign doesn't count.
  assert.match(html, /<h2>Ben<\/h2>.*?<dt>sign<\/dt><dd>1<\/dd>.*?<dt>state<\/dt><dd>1<\/dd>/);
  assert.match(html, /<h2>Ada<\/h2>.*?<dt>signs<\/dt><dd>2<\/dd>.*?<dt>states<\/dt><dd>2<\/dd>/);
  assert.ok(!/badges?<\/dt>/.test(html));
  assert.ok(!html.includes('Ben Held'));
  // The newest sign's math on its plate; a player with only ways shows their newest way.
  assert.match(
    html,
    /<span class="label">Newest sign<\/span><div class="plate"><span role="img" aria-label="18 ÷ 6 = 3">/
  );
  // Cy has no signs of their own, so no numbers to show.
  assert.match(html, /<h2>Cy<\/h2><span class="sub">Playing since 2026<\/span><\/span><\/span><span class="newest">/);
  assert.match(
    html,
    /<span class="label">Newest way<\/span><div class="plate"><span role="img" aria-label="19 − 12 = 7">.*?<b>Ada Old<\/b>/
  );
  assert.match(
    html,
    /<a href="\/app" data-tinylytics-event="app\.get" data-tinylytics-event-value="players">Get the app →<\/a>/
  );
});

test('/app sends readers to the beta, with a code for a computer and three screens of the app', async () => {
  const { app, page } = await setup();
  const { res, html } = await page('/app');
  assert.equal(res.status, 200);
  assert.match(
    html,
    /<a class="testflight" href="https:\/\/testflight\.apple\.com\/join\/Httdw7ZY" data-tinylytics-event="beta\.join" data-tinylytics-event-value="app">/
  );
  assert.match(html, /<a class="get" href="\/app" aria-current="page"/);
  assert.match(html, /<span role="img" aria-label="QR code for the iPhone beta"><svg /);
  // The code is made for the beta's address; run `npm run app-assets` when it changes.
  assert.equal(BETA_QR_FOR, TESTFLIGHT_URL);
  assert.match(BETA_QR_SVG, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  for (const name of ['camera', 'sign', 'home']) {
    assert.match(
      html,
      new RegExp(`<img src="/app/${name}\\.webp" alt="[^"]+" width="414" height="900" loading="lazy"/>`)
    );
    const shot = await app.request(`/app/${name}.webp`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/webp');
    const bytes = new Uint8Array(await shot.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
    assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WEBP');
  }
});

test('the header names Map, Signs, Players and About, and marks the page you are on', async () => {
  const { page } = await setup();
  const nav = (html: string) => /<nav aria-label="Main">(.*?)<\/nav>/.exec(html)?.[1] ?? '';
  const home = nav((await page('/')).html);
  assert.equal(
    home,
    '<a href="/" aria-current="page">Map</a><a href="/signs">Signs</a><a href="/players">Players</a><a href="/about">About</a>'
  );
  assert.match(nav((await page('/about')).html), /<a href="\/about" aria-current="page">About<\/a>/);
  assert.match(nav((await page('/players/ada')).html), /<a href="\/players" aria-current="page">Players<\/a>/);
  assert.match(nav((await page('/signs/ada-new')).html), /<a href="\/signs" aria-current="page">Signs<\/a>/);
});

test('the sitemap lists /players and /app', async () => {
  const { page } = await setup();
  const xml = (await page('/sitemap.xml')).html;
  assert.ok(xml.includes('<loc>https://example.test/players</loc>'));
  assert.ok(xml.includes('<loc>https://example.test/app</loc>'));
});
