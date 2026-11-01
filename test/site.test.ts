import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { HIGHWAY_SVG } from '../src/web/brand.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign, way } from './support/fixtures.ts';

/** The drawn dot between two facts, with the comma screen readers hear. */
const SEP = '<span class="sep"><span class="vh">, </span></span>';

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

test('home’s app section links the public TestFlight beta', async () => {
  const { app } = await setup();
  const html = await (await app.request('/')).text();
  assert.match(
    html,
    /<a class="testflight" href="https:\/\/testflight\.apple\.com\/join\/Httdw7ZY" data-tinylytics-event="beta\.join" data-tinylytics-event-value="home">/
  );
  // Tinylytics counts clicks on the way to the app.
  assert.match(
    html,
    /<a class="get" href="\/app" data-tinylytics-event="app\.get" data-tinylytics-event-value="header">/
  );
  assert.ok(html.includes('Join the iPhone beta'));
});

test('the privacy page says what is public and what is not, and every page links it', async () => {
  const { app } = await setup();
  const res = await app.request('/privacy');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<h1>Privacy</h1>'));
  assert.ok(html.includes('Delete my account'));
  assert.match(await (await app.request('/')).text(), /<a href="\/privacy">Privacy<\/a>/);
});

test('the about page tells the story, links the archive and the beta, and every page links it', async () => {
  const { app } = await setup();
  const res = await app.request('/about');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<h1>About</h1>'));
  assert.ok(html.includes('https://thingelstad.xyz/things/road-sign-math/'));
  assert.match(html, /data-tinylytics-event="beta\.join" data-tinylytics-event-value="about"/);
  // No Genesis sign among the fixtures: the plate stands alone, with no link to a missing page.
  assert.ok(!html.includes('href="/signs/genesis"'));
  assert.match(await (await app.request('/')).text(), /<a href="\/about">About<\/a>/);
  const xml = await (await app.request('/sitemap.xml')).text();
  assert.ok(xml.includes('<loc>https://example.test/about</loc>'));
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
  assert.match(await res.text(), /<h1 class="p-name">Newer Sign<\/h1>/);
  assert.equal((await app.request(`/signs/${slug('Held Sign')}`)).status, 404);
  const missing = await app.request('/signs/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('a sign’s math is drawn as SVG on its plate and on every card, with the text for screen readers', async () => {
  const { app, slug } = await setup();
  const page = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.match(page, /<div class="plate"><span role="img" aria-label="18 ÷ 6 = 3"><svg aria-hidden="true" /);
  assert.match(
    await (await app.request('/')).text(),
    /<span class="eq mj" role="img" aria-label="7 \+ 12 = 19"><svg aria-hidden="true" /
  );
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
  // No analytics here: the URL holds the link's token. (The header's event tags are inert without the script.)
  assert.ok(!html.includes('tinylytics.app'));
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
  assert.ok(html.includes('<h1 class="p-name">Ada</h1>'));
  assert.match(html, /<ul class="badges">/);
  // Each badge says how it is earned, and links to the sign that earned it.
  assert.ok(
    html.includes('<a href="/signs/older-sign"><svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">')
  );
  assert.ok(
    html.includes(
      '<span class="what"><strong>First Sign</strong><span>Post your first sign.</span><span class="with">Earned Jan 10, 2026 with Older Sign</span></span>'
    )
  );
  assert.ok(html.includes('<strong>Fair Share</strong><span>Use ÷ in a way.</span>'));
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
  assert.ok(html.includes(`<h2 id="picked-h">Minnesota${SEP}2 signs</h2>`));
  assert.match(html, /Not on the map: <a href="\/signs\/nowhere">Nowhere<\/a> \(Somewhere on I-90\)/);
  assert.ok(html.includes(`<a href="/?year=2025#map" data-map="">2025${SEP}1</a>`));
  assert.match(html, /<dd class="mono p-sign-count">4<\/dd>/);

  // A year leaves the other years' signs off the map, and a pin picks its place.
  const year = await (await app.request('/?year=2024&at=far-away')).text();
  assert.match(year, /aria-label="North Two town: 1 sign"/);
  assert.ok(year.includes(`<h2 id="picked-h">Far Away town${SEP}1 sign</h2>`));
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
    const svg = await res.text();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, path);
    // The icon is the identity's Highway, as the package draws it.
    if (path === '/favicon.svg') assert.equal(svg, HIGHWAY_SVG);
  }
});

test('a sign’s page has its numbers, where it is on the map, and the signs nearby', async () => {
  const { app, slug } = await setup();
  const html = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.match(html, /<ul class="nums" aria-label="Numbers on the sign">/);
  assert.ok(
    html.includes('<span class="label">Testville, Minnesota</span><a href="/?at=newer-sign#map">See it on the map</a>')
  );
  assert.match(html, /<a class="where" href="\/\?at=newer-sign#map" tabindex="-1" aria-hidden="true">/);
  assert.ok(html.includes('<p class="note">The pin is on the town, not the exact spot.</p>'));
  assert.match(html, /<h2 id="near-h">Nearby<\/h2>/);
  assert.match(html, /<span class="dist mono">0 mi<\/span>/);
  assert.ok(
    html.includes(
      '<a class="another" href="/app" data-tinylytics-event="app.get" data-tinylytics-event-value="sign">Find another way in the app <span aria-hidden="true">→</span></a>'
    )
  );
  assert.ok(!html.includes('Held Sign'));
});

test('a player’s page shows their signs as photos, or on the map', async () => {
  const { app } = await setup();
  const grid = await (await app.request('/players/ada')).text();
  assert.match(grid, /<ul class="squares" aria-label="Ada’s signs">/);
  assert.ok(grid.includes(`<a class="chip" href="/players/ada" aria-current="page">Signs${SEP}2</a>`));
  // Each square: the photo with its math on a plate (read out, not hidden), then the title, the day and the state.
  assert.ok(
    grid.includes(
      `<span class="tag"><span>7 + 12 = 19</span></span></span><strong>Newer Sign</strong><span class="soft">Jan 10, 2026${SEP}Minnesota</span>`
    )
  );
  const map = await (await app.request('/players/ada?view=map')).text();
  assert.ok(!map.includes('class="squares"'));
  assert.match(map, /<a class="pin many" href="\/\?at=newer-sign#map"/);
  assert.match(map, /<a class="chip" href="\/players\/ada\?view=map" aria-current="page">Map<\/a>/);
});

test('a player’s page leads with the way back, when they started, their feed, and no badge count', async () => {
  const { app } = await setup();
  const html = await (await app.request('/players/ada')).text();
  assert.ok(
    html.includes(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/players">All players</a></li><li><span aria-current="page">Ada</span></li></ol></nav>'
    )
  );
  assert.ok(
    html.includes(
      '<div class="id"><h1 class="p-name">Ada</h1><p class="bio p-note">Counts everything.</p><p class="since">Playing since 2026</p></div>'
    )
  );
  assert.ok(
    html.includes('<dl class="stats"><div><dt>signs</dt><dd>2</dd></div><div><dt>state</dt><dd>1</dd></div></dl>')
  );
  assert.match(
    html,
    /<a class="feed" href="\/players\/ada\/feed\.xml" type="application\/atom\+xml"><svg [^>]*>.*?<\/svg>Follow Ada’s signs \(feed\)<\/a>/
  );
  assert.ok(!/<dt>badges?<\/dt>/.test(html), 'others see the badges, never a count');
  assert.ok(html.includes('Earned on the road. Some badges are secret until someone finds them.'));
});

test('a sign’s page reads like the design: the way back, the title, who found it and when, the first way', async () => {
  const { app } = await setup();
  const html = await (await app.request('/signs/newer-sign')).text();
  assert.ok(
    html.includes(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/signs">All signs</a></li><li><a href="/signs?state=MN">Minnesota</a></li><li><span aria-current="page">Newer Sign</span></li></ol></nav>'
    )
  );
  const order = [
    '<h1 class="p-name">',
    '<p class="by">',
    '<div class="acts">',
    '<div class="first">',
    '<div class="cta">'
  ].map((part) => html.indexOf(part));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `in the design’s order: ${order}`
  );
  assert.ok(
    html.includes(
      `<a href="/players/ada">Ada</a> found it on <time class="dt-published" datetime="2026-01-10">Jan 10, 2026</time></span>${SEP}<span>Testville, Minnesota</span></p>`
    )
  );
  // Share shows only where the browser can share; copy only where it can copy.
  assert.match(
    html,
    /<button type="button" class="act share" data-url="https:\/\/example\.test\/signs\/newer-sign" data-title="Newer Sign" hidden="">/
  );
  assert.match(
    html,
    /<button type="button" class="act copy" data-url="https:\/\/example\.test\/signs\/newer-sign" hidden="">/
  );
  assert.match(html, /<div class="first"><div class="plate"><span role="img" aria-label="18 ÷ 6 = 3">/);
  assert.ok(
    html.includes(
      `<p class="credit"><a href="/players/ada">Ada</a>${SEP}<span>both sides are 3</span><span class="count">1 way so far</span></p>`
    )
  );
  assert.ok(!html.includes('id="ways-h"'), 'no list of more ways when there is only the first');
  assert.ok(html.includes('<strong>See another way to make it true?</strong>'));
});

test('a sign’s page lists the ways after the first, and asks for one when there is none', async () => {
  const { app, store } = await setup();
  await store.addWay(
    way('01JS0000000000000000000002', {
      id: 'way-second',
      text: '18 − 6 = 12',
      value: '12',
      numbers: ['18', '6', '12'],
      createdAt: '2026-02-02T00:00:00.000Z'
    })
  );
  const two = await (await app.request('/signs/newer-sign')).text();
  assert.ok(two.includes('<span class="count">2 ways so far</span>'));
  assert.match(
    two,
    /<h2 id="ways-h">More ways<\/h2><ul><li>.*?<span class="eq" role="img" aria-label="18 − 6 = 12"><svg aria-hidden="true" /s
  );
  assert.equal(two.match(/both sides are/g)?.length, 2);

  await store.putSign(
    sign({
      id: '01JS0000000000000000000009',
      title: 'Open Sign',
      postedAt: '2026-03-01T00:00:00.000Z',
      wayCount: 0,
      firstWay: undefined
    })
  );
  const none = await (await app.request('/signs/open-sign')).text();
  assert.ok(none.includes('<p class="unsolved">Nobody has solved it yet.</p>'));
  assert.ok(!none.includes('class="first"'));
  assert.ok(none.includes('<strong>Can you make it true?</strong>'));
  assert.ok(none.includes('>Solve it in the app <span aria-hidden="true">→</span></a>'));
});

test('a sign’s numbers say where each one was read, and the page steps to the older and newer signs', async () => {
  const { app, store } = await setup();
  await store.putSign(
    sign({
      id: '01JS0000000000000000000009',
      title: 'Read Sign',
      postedAt: '2026-01-15T00:00:00.000Z',
      numbers: [{ value: '2', text: 'HOV 2+', why: 'Read as 2' }, { value: '82', text: '82nd St' }, { value: '1' }]
    })
  );
  const html = await (await app.request('/signs/read-sign')).text();
  assert.ok(
    html.includes('<h2 id="nums-h">The numbers on this sign</h2><p>Three numbers, and where each one was read.</p>')
  );
  assert.ok(
    html.includes(
      '<ul class="nums" aria-label="Numbers on the sign"><li><b class="mono">2</b><span class="from">from HOV 2+</span><span class="why">Read as 2</span></li><li><b class="mono">82</b><span class="from">from 82nd St</span></li><li><b class="mono">1</b></li></ul>'
    )
  );
  // Posted between the other two, so it has both an older and a newer sign.
  assert.match(
    html,
    /<a class="turn older" href="\/signs\/older-sign">.*?<span class="k">Older<\/span><strong>Older Sign<\/strong>/s
  );
  assert.match(
    html,
    /<a class="turn newer" href="\/signs\/newer-sign"><span class="words"><span class="k">Newer<\/span><strong>Newer Sign<\/strong>/
  );

  // A number read as itself says nothing more; the ends of the line say so.
  const newest = await (await app.request('/signs/newer-sign')).text();
  assert.ok(newest.includes('<p>Three numbers.</p>'));
  assert.ok(newest.includes('<strong>This is the newest sign</strong><a href="/signs">See every sign</a>'));
  const first = await (await app.request('/signs/older-sign')).text();
  assert.ok(first.includes('<strong>This is the first sign</strong><a href="/signs">See every sign</a>'));
});
