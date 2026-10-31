import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign, way } from './support/fixtures.ts';

async function setup(appleTeamId?: string) {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await store.putSign(
    sign({ id: '01JS0000000000000000000001', title: 'Older Sign', postedAt: '2026-01-01T00:00:00.000Z' })
  );
  await store.putSign(
    sign({ id: '01JS0000000000000000000002', title: 'Newer Sign', postedAt: '2026-02-01T00:00:00.000Z' })
  );
  await store.putSign(sign({ id: '01JS0000000000000000000003', title: 'Held Sign', visibility: 'held' }));
  await store.addWay(way('01JS0000000000000000000002', { text: '18 ÷ 6 = 3', value: '3', numbers: ['18', '6', '3'] }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    appleTeamId
  });
  const signs = await store.allSigns();
  return { app, store, slug: (title: string) => signs.find((s) => s.title === title)!.slug };
}

test('the home page lists shown signs, newest first, and is cached', async () => {
  const { app } = await setup();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const html = await res.text();
  assert.ok(html.indexOf('Newer Sign') < html.indexOf('Older Sign'));
  assert.ok(!html.includes('Held Sign'));
  // Tinylytics counts the visit.
  assert.match(
    html,
    /<script defer="" src="https:\/\/tinylytics\.app\/js\/script\.js" data-site="ryhTaXDDgZtyCktoVzzj"><\/script>/
  );
});

test('every sign has a heart: Tinylytics’ kudos button at the sign’s path', async () => {
  const { app, slug } = await setup();
  const home = await (await app.request('/')).text();
  const button = (s: string) =>
    `<button type="button" class="tinylytics_kudos" data-path="/signs/${s}" aria-label="Heart the`;
  assert.ok(home.includes(button(slug('Newer Sign'))));
  assert.ok(home.includes(button(slug('Older Sign'))));
  // Outside the card's link, so a tap hearts the sign instead of opening it.
  assert.match(home, /<\/a><div class="heart"><button type="button" class="tinylytics_kudos"/);
  const page = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  // The sign's own heart once; the nearby signs' are their own.
  assert.equal(page.split(button(slug('Newer Sign'))).length, 2);
});

test('a sign has its own page; a held or unknown one is not found', async () => {
  const { app, slug } = await setup();
  const res = await app.request(`/signs/${slug('Newer Sign')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>Newer Sign<\/h1>/);
  assert.equal((await app.request(`/signs/${slug('Held Sign')}`)).status, 404);
  const missing = await app.request('/signs/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('a sign’s math is drawn as SVG on its plate, with the text for screen readers; cards carry the text', async () => {
  const { app, slug } = await setup();
  const page = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.match(page, /<div class="plate"><span role="img" aria-label="18 ÷ 6 = 3"><svg aria-hidden="true" /);
  assert.match(page, /<span class="eq" role="img" aria-label="18 ÷ 6 = 3"><svg aria-hidden="true" /);
  assert.match(await (await app.request('/')).text(), /<span class="eq">7 \+ 12 = 19<\/span>/);
});

test('apple-app-site-association opens the sign-in link and sign pages in the app', async () => {
  const { app } = await setup('ABCDE12345');
  for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    const body = (await res.json()) as { applinks: { details: unknown[] } };
    assert.deepEqual(body.applinks.details, [
      {
        appIDs: ['ABCDE12345.xyz.roadsignmath.app'],
        components: [
          { '/': '/signin', comment: 'The sign-in link in the email' },
          { '/': '/signs/?*', comment: 'A sign’s page' },
          { '/': '/players/?*', comment: 'A player’s page' }
        ]
      }
    ]);
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path}`);
  }
});

test('without a team id there is no apple-app-site-association', async () => {
  const { app } = await setup();
  assert.equal((await app.request('/.well-known/apple-app-site-association')).status, 404);
  assert.equal((await app.request('/apple-app-site-association')).status, 404);
});

test('the sign-in link in a browser says where to use it, and is never cached', async () => {
  const { app } = await setup('ABCDE12345');
  const res = await app.request('/signin?l=01JLOGIN&t=secret-token-value');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.match(html, /Sign in on your iPhone/);
  assert.ok(!html.includes('secret-token-value'));
  assert.ok(!html.includes('01JLOGIN'));
  // No analytics here: the URL holds the link's token.
  assert.ok(!html.includes('tinylytics'));
});

test('a profile photo stands in for the letter on the player page, who’s playing and the sign', async () => {
  const { app, store, slug } = await setup();
  const letter = await (await app.request('/players/ada')).text();
  assert.ok(!letter.includes('avatar photo'));
  await store.setAvatar(ada.id, 'face1');
  const page = await (await app.request('/players/ada')).text();
  assert.ok(page.includes('<img src="/p/face1/large.jpg" alt="" loading="lazy"/>'), 'the big face');
  const home = await (await app.request('/')).text();
  assert.ok(home.includes('<img src="/p/face1/thumb.jpg"'), 'who’s playing');
  const sign = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.ok(sign.includes('<img src="/p/face1/thumb.jpg"'), 'the finder and the way');
});

test('a player’s page shows the badges they earned as road signs, and nothing about the rest', async () => {
  const { app } = await setup();
  const res = await app.request('/players/ada');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<h1>Ada</h1>'));
  assert.match(html, /<ul class="badges">/);
  assert.match(
    html,
    /<a href="\/signs\/older-sign" title="First Sign\. Post your first sign\. Earned 2026-01-10 with Older Sign\.">/
  );
  assert.match(html, /<svg viewBox="0 0 64 64" width="56" height="56" role="img" aria-label="Fair Share\./);
  assert.ok(!html.includes('Lookout'), 'no badge that isn’t earned');
  assert.ok(!/\d+ badges?/i.test(html), 'no count');
  assert.ok(!html.includes('Held Sign'));
  assert.equal((await app.request('/players/nobody')).status, 404);
});

test('home puts every shown sign on the map: pins, clusters, the year filter and the picked place', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  const at = (id: string, title: string, lat: number, lng: number, foundOn: string) =>
    sign({
      id,
      title,
      foundOn,
      postedAt: `${foundOn}T12:00:00.000Z`,
      place: { label: `${title} town`, state: 'MN', lat, lng, approximate: true }
    });
  await store.putSign(at('01JS0000000000000000000011', 'North One', 47.5, -94.9, '2025-06-01'));
  await store.putSign(at('01JS0000000000000000000012', 'North Two', 47.52, -94.88, '2024-06-01'));
  await store.putSign(at('01JS0000000000000000000013', 'Far Away', 33.4, -112.0, '2024-07-01'));
  await store.putSign(
    sign({
      id: '01JS0000000000000000000014',
      title: 'Nowhere',
      foundOn: '2024-08-01',
      postedAt: '2024-08-01T12:00:00.000Z',
      place: { label: 'Somewhere on I-90', approximate: true }
    })
  );
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const html = await (await app.request('/')).text();
  // Two signs a few miles apart share one pin with a count; the newest pin is picked.
  assert.match(
    html,
    /<a class="pin many" href="\/\?at=north-one#map"[^>]*aria-label="Minnesota: 2 signs" aria-current="true"/
  );
  assert.match(html, /<a class="pin" href="\/\?at=far-away#map"[^>]*aria-label="Far Away town: 1 sign"/);
  assert.match(html, /<h2 id="picked-h">Minnesota · 2 signs<\/h2>/);
  assert.match(html, /Not on the map: <a href="\/signs\/nowhere">Nowhere<\/a> \(Somewhere on I-90\)/);
  assert.match(html, /<a href="\/\?year=2025#map" data-map="">2025 · 1<\/a>/);
  assert.match(html, /<dd class="mono">4<\/dd>/);

  // A year leaves the other years' signs off the map, and a pin picks its place.
  const year = await (await app.request('/?year=2024&at=far-away')).text();
  assert.match(year, /aria-label="North Two town: 1 sign"/);
  assert.match(year, /<h2 id="picked-h">Far Away town · 1 sign<\/h2>/);
  assert.match(year, /<a href="\/\?year=2024#map" aria-current="true" data-map="">/);
  // An unknown year or place falls back to everything, never an error.
  assert.equal((await app.request('/?year=1999&at=nope')).status, 200);
});

test('robots.txt points to the sitemap, which lists every page that answers and none that do not', async () => {
  const { app, slug } = await setup();
  const robots = await (await app.request('/robots.txt')).text();
  assert.match(robots, /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  const res = await app.request('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/xml/);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.includes('https://example.test/'));
  assert.ok(locs.includes(`https://example.test/signs/${slug('Newer Sign')}`));
  assert.ok(!locs.some((l) => l.endsWith(`/signs/${slug('Held Sign')}`)), 'held signs are not listed');
  for (const loc of locs) {
    const page = await app.request(loc.replace('https://example.test', ''));
    assert.equal(page.status, 200, loc);
  }
  // The newer sign's lastmod is its way's, which came after it was posted.
  assert.match(xml, new RegExp(`/signs/${slug('Older Sign')}</loc><lastmod>2026-01-01T00:00:00.000Z</lastmod>`));
});

test('the map picture and the icon are served and kept a day', async () => {
  const { app } = await setup();
  for (const path of ['/us-map.svg', '/favicon.svg']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    assert.match(await res.text(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox=/);
  }
});

test('a sign’s page has its numbers, where it is on the map, and the signs nearby', async () => {
  const { app, slug } = await setup();
  const html = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.match(html, /<ul class="nums" aria-label="Numbers on the sign">/);
  assert.match(html, /<a class="where" href="\/\?at=newer-sign#map"/);
  assert.match(html, /Testville, Minnesota \(the pin is on the town, not the exact spot\)/);
  assert.match(html, /<h2 id="near-h">Nearby<\/h2>/);
  assert.match(html, /<span class="dist mono">0 mi<\/span>/);
  assert.match(html, /<a class="another" href="\/#app">Find another way in the app<\/a>/);
  assert.ok(!html.includes('Held Sign'));
});

test('a player’s page shows their signs as photos, or on the map', async () => {
  const { app } = await setup();
  const grid = await (await app.request('/players/ada')).text();
  assert.match(grid, /<ul class="squares" aria-label="Ada’s signs">/);
  assert.match(grid, /<a href="\/players\/ada" aria-current="page">Signs<\/a>/);
  const map = await (await app.request('/players/ada?view=map')).text();
  assert.ok(!map.includes('class="squares"'));
  assert.match(map, /<a class="pin many" href="\/\?at=newer-sign#map"/);
  assert.match(map, /<a href="\/players\/ada\?view=map" aria-current="page">Map<\/a>/);
});
