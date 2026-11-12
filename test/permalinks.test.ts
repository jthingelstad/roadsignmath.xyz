// Pages addressed by id (Jamie, 2026-11-12: "anchor them on id's and not names"; "just use ID"):
// the new addresses, the old ones by slug and handle going there with a 301 that keeps the query,
// and what must not move with them: feed item ids, heart keys, share card paths and the API's
// player lookup by handle. Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { PAGE_CACHE } from '../src/edge-cache.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { FakeTinylytics } from './support/tinylytics.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';
const EXIT = '01JS0000000000000000000001';
const MILE = '01JS0000000000000000000002';
const HELD = '01JS0000000000000000000003';
// Dee has a name but no sign, way or badge: no page.
const dee: Player = { ...ben, id: '01JDDDDDDDDDDDDDDDDDDDDDDD', handle: 'dee', name: 'Dee' };

async function setup() {
  const store = new MemoryStore();
  const tinylytics = new FakeTinylytics();
  for (const player of [ada, ben, dee]) await addPlayer(store, player);
  await addSign(store, sign({ id: EXIT, title: 'Exit Seven', postedAt: '2026-01-10T12:00:00.000Z' }));
  await addSign(
    store,
    sign({
      id: MILE,
      title: 'Mile Twelve',
      postedAt: '2026-01-11T12:00:00.000Z',
      postedBy: ben.id,
      finders: [{ playerId: ben.id, name: ben.name, role: 'found' }]
    })
  );
  await addSign(store, sign({ id: HELD, title: 'Held Back', visibility: 'held' }));
  await store.addWay(way(EXIT));
  await store.addWay(way(MILE, { playerId: ben.id }));
  const app = createApp({
    store,
    urls: { site: SITE, quiz: QUIZ },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    tinylytics,
    quizOpen: true
  });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  return { app, store, tinylytics, get };
}

const meta = (html: string, property: string) =>
  new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1];
const canonical = (html: string) => /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];

test('a sign’s page and a player’s page answer at their ids, and name that address as theirs', async () => {
  const { get } = await setup();
  const exit = await get(`/signs/${EXIT}`);
  assert.equal(exit.res.status, 200);
  assert.equal(canonical(exit.text), `${SITE}/signs/${EXIT}`);
  assert.equal(meta(exit.text, 'og:url'), `${SITE}/signs/${EXIT}`);
  assert.match(meta(exit.text, 'apple-itunes-app') ?? '', new RegExp(`app-argument=${SITE}/signs/${EXIT}$`));
  assert.ok(exit.text.includes(`href="/players/${ada.id}"`), 'its finder, by id');
  assert.ok(!exit.text.includes('href="/players/ada"'));
  assert.ok(exit.text.includes(`href="${QUIZ}/signs/${EXIT}"`), 'Try this one in Quiz, by id');

  const player = await get(`/players/${ada.id}`);
  assert.equal(player.res.status, 200);
  assert.equal(canonical(player.text), `${SITE}/players/${ada.id}`);
  assert.equal(meta(player.text, 'og:url'), `${SITE}/players/${ada.id}`);
  assert.ok(player.text.includes(`href="/signs/${EXIT}"`), 'their signs, by id');
  assert.ok(!player.text.includes('href="/signs/exit-seven"'));
  assert.ok(player.text.includes(`href="/players/${ada.id}?view=map"`), 'the map view, by id');
  assert.ok(player.text.includes(`href="/players/${ada.id}/feed.xml"`), 'their feed, by id');

  const home = await get('/');
  assert.ok(home.text.includes(`href="/signs/${EXIT}"`) && home.text.includes(`href="/players/${ben.id}"`));
  assert.ok(!/href="\/(signs|players)\/[a-z]/.test(home.text), 'no page linked by slug or handle');
});

test('an old address by slug or handle, or an id in another case, goes to the id’s with the query kept', async () => {
  const { get } = await setup();
  for (const [from, to] of [
    ['/signs/exit-seven', `/signs/${EXIT}`],
    ['/signs/mile-twelve?sort=latest', `/signs/${MILE}?sort=latest`],
    [`/signs/${EXIT.toLowerCase()}`, `/signs/${EXIT}`],
    ['/players/ada', `/players/${ada.id}`],
    ['/players/ada?view=map', `/players/${ada.id}?view=map`],
    [`/players/${ben.id.toLowerCase()}?view=map`, `/players/${ben.id}?view=map`],
    ['/players/ada/feed.xml', `/players/${ada.id}/feed.xml`],
    ['/players/ben/feed.json?x=1', `/players/${ben.id}/feed.json?x=1`]
  ]) {
    const { res, location } = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(location, to, from);
    assert.equal(res.headers.get('cache-control'), PAGE_CACHE, from);
  }
  // The feeds' move is open to any origin, like the feeds.
  const feed = await get('/players/ada/feed.json');
  assert.equal(feed.res.headers.get('access-control-allow-origin'), '*');
});

test('a key that names nothing, a held sign or a player with no page stays a 404, wherever it is asked', async () => {
  const { get } = await setup();
  for (const path of [
    '/signs/no-such-sign',
    '/signs/01JS0000000000000000000099',
    `/signs/${HELD}`,
    '/signs/held-back',
    '/players/nobody',
    '/players/01JZZZZZZZZZZZZZZZZZZZZZZZ',
    `/players/${dee.id}`,
    '/players/dee',
    '/players/dee/feed.json',
    `/players/${dee.id}/feed.xml`
  ]) {
    assert.equal((await get(path)).res.status, 404, path);
  }
});

test('the open files, lists and sitemap still answer beside the id addresses, and name the ids', async () => {
  const { get } = await setup();
  for (const path of ['/signs', '/players', '/signs.json', '/signs.geojson', '/players.json', '/feed.json']) {
    assert.equal((await get(path)).res.status, 200, path);
  }
  const signs = JSON.parse((await get('/signs.json')).text);
  assert.deepEqual(
    signs.signs.map((s: { url: string }) => s.url),
    [`${SITE}/signs/${MILE}`, `${SITE}/signs/${EXIT}`]
  );
  const players = JSON.parse((await get('/players.json')).text);
  const adaRecord = players.players.find((p: { handle: string }) => p.handle === 'ada');
  assert.equal(adaRecord.id, ada.id);
  assert.equal(adaRecord.url, `${SITE}/players/${ada.id}`);
  assert.equal(adaRecord.feed_url, `${SITE}/players/${ada.id}/feed.json`);
  const geo = JSON.parse((await get('/signs.geojson')).text);
  assert.ok(geo.features.every((f: { properties: { url: string } }) => /\/signs\/01JS/.test(f.properties.url)));

  const sitemap = (await get('/sitemap.xml')).text;
  assert.ok(sitemap.includes(`<loc>${SITE}/signs/${EXIT}</loc>`));
  assert.ok(sitemap.includes(`<loc>${SITE}/players/${ada.id}</loc>`));
  assert.ok(!sitemap.includes('/signs/exit-seven') && !sitemap.includes('/players/ada<'));
  const llms = (await get('/llms.txt')).text;
  assert.ok(llms.includes(`${SITE}/signs/${EXIT}`) && !llms.includes(`${SITE}/signs/exit-seven`));
});

test('the API finds a player by their id as well as by their handle, with the same answer', async () => {
  const { get } = await setup();
  const byHandle = await get('/api/v1/players/ada');
  const byId = await get(`/api/v1/players/${ada.id}`);
  assert.equal(byHandle.res.status, 200);
  assert.equal(byId.res.status, 200);
  assert.deepEqual(JSON.parse(byId.text), JSON.parse(byHandle.text));
  assert.equal(JSON.parse(byId.text).handle, 'ada');
  assert.equal(JSON.parse(byId.text).url, `${SITE}/players/${ada.id}`);
  // A sign by slug or id answers as before, its url now the id's.
  assert.equal(JSON.parse((await get('/api/v1/signs/exit-seven')).text).url, `${SITE}/signs/${EXIT}`);
  for (const path of ['/api/v1/players/nobody', '/api/v1/players/01JZZZZZZZZZZZZZZZZZZZZZZZ']) {
    assert.equal((await get(path)).res.status, 404, path);
  }
});

test('a feed item keeps its id, the sign’s address by slug, while its link moves to the id', async () => {
  const { get } = await setup();
  const json = JSON.parse((await get('/feed.json')).text);
  const exit = json.items.find((i: { id: string }) => i.id.endsWith('/exit-seven'));
  assert.equal(exit.id, `${SITE}/signs/exit-seven`);
  assert.equal(exit.url, `${SITE}/signs/${EXIT}`);
  const atom = (await get('/feed.xml')).text;
  const entry = [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]).find((e) => e.includes(EXIT))!;
  assert.ok(entry.includes(`<id>${SITE}/signs/exit-seven</id>`));
  assert.ok(entry.includes(`<link href="${SITE}/signs/${EXIT}" rel="alternate" type="text/html"/>`));
  // The feeds' own ids stay too: Home, and a player's address by handle.
  assert.ok(atom.includes(`  <id>${SITE}/</id>`));
  const players = (await get(`/players/${ada.id}/feed.xml`)).text;
  assert.ok(players.includes(`  <id>${SITE}/players/ada</id>`));
  assert.ok(players.includes(`<link href="${SITE}/players/${ada.id}" rel="alternate" type="text/html"/>`));
  const playerJson = JSON.parse((await get(`/players/${ada.id}/feed.json`)).text);
  assert.deepEqual(
    playerJson.items.map((i: { id: string }) => i.id),
    [`${SITE}/signs/exit-seven`]
  );
});

test('a heart stays keyed by the sign’s slug: on the page, in the API and in Popular', async () => {
  const { app, get, tinylytics } = await setup();
  tinylytics.kudosKept.push(
    { path: '/signs/exit-seven', uid: 'web-1' },
    { path: '/signs/exit-seven', uid: 'web-2' },
    { path: `/signs/${MILE}`, uid: 'web-3' }
  );
  const page = (await get(`/signs/${EXIT}`)).text;
  assert.ok(page.includes('data-path="/signs/exit-seven"'));
  assert.ok(!page.includes(`data-path="/signs/${EXIT}"`));
  const api = JSON.parse((await get(`/api/v1/signs/${EXIT}`)).text);
  assert.equal(api.hearts, 2, 'the kudos at the slug count');
  const mile = JSON.parse((await get(`/api/v1/signs/${MILE}`)).text);
  assert.equal(mile.hearts, 0, 'a kudo at the id is not the sign’s heart');
  const popular = JSON.parse((await get('/api/v1/signs/popular')).text);
  assert.equal(popular.signs[0].id, EXIT);
  const site = (await (await app.request('/signs?sort=popular')).text()).indexOf(`href="/signs/${EXIT}"`);
  const other = (await (await app.request('/signs?sort=popular')).text()).indexOf(`href="/signs/${MILE}"`);
  assert.ok(site >= 0 && site < other, 'the site’s Popular reads the same counts');
});

test('share cards keep their slug and handle paths, and the page the card maker reaches by them names it', async () => {
  const { get } = await setup();
  const card = (html: string) => meta(html, 'og:image');
  const exit = await get(`/signs/${EXIT}`);
  assert.match(
    card(exit.text) ?? '',
    /^https:\/\/cards\.thingelstad\.com\/rsm\/signs\/exit-seven\.png\?v=[0-9a-f]{10}$/
  );
  // The card maker fetches the page by the card's path, and follows the 301 on the same origin.
  const old = await get('/signs/exit-seven');
  assert.equal(old.location, `/signs/${EXIT}`);
  const player = await get(`/players/${ada.id}`);
  assert.match(card(player.text) ?? '', /^https:\/\/cards\.thingelstad\.com\/rsm\/players\/ada\.png\?v=[0-9a-f]{10}$/);
  assert.equal((await get('/players/ada')).location, `/players/${ada.id}`);
  // It picks the h-card whose u-url is the address it fetched: both are there.
  const urls = [...player.text.matchAll(/<data hidden="" class="u-url" value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(urls, [`${SITE}/players/${ada.id}`, `${SITE}/players/ada`]);
});
