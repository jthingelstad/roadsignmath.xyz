import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import { HeartCounts, heartUid } from '../src/hearts.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { FakeTinylytics } from './support/tinylytics.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const EXIT = '01JS0000000000000000000001';
const BENS = '01JS0000000000000000000002';
const HELD = '01JS0000000000000000000003';

async function setup(fake: FakeTinylytics | null = new FakeTinylytics()) {
  const tinylytics = fake ?? undefined;
  const store = new MemoryStore();
  const photos = new MemoryPhotoStore();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos,
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    tinylytics
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben]) {
    await addPlayer(store, player);
    const secret = player.handle.padEnd(43, 'x');
    await store.putSession({
      playerId: player.id,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: new Date().toISOString(),
      expiresAt: nowSeconds() + 3600
    });
    tokens[player.handle] = `rsm_${player.id}_${secret}`;
  }
  await addSign(store, sign({ id: EXIT, title: 'Exit Seven' }));
  await addSign(store, sign({ id: BENS, title: 'Bens Sign', postedBy: ben.id, postedAt: '2026-02-01T00:00:00.000Z' }));
  await addSign(store, sign({ id: HELD, title: 'Held Sign', visibility: 'held' }));
  const call = async (
    method: string,
    path: string,
    options: { as?: string; body?: unknown; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.as) headers.authorization = `Bearer ${tokens[options.as]}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await res.text();
    return { res, body: (text ? JSON.parse(text) : null) as Json };
  };
  return { store, photos, tinylytics, call };
}

test('a heart is one kudo at the sign’s path, given and taken back once however often it is sent', async () => {
  const { store, tinylytics, call } = await setup();
  // Someone on the website hearted it already.
  tinylytics!.kudosKept.push({ path: '/signs/exit-seven', uid: 'web-visitor' });
  const put = await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.body, { hearted: true, hearts: 2 });
  assert.equal(put.res.headers.get('cache-control'), 'no-store');
  const again = await call('PUT', `/signs/${EXIT}/heart`, { as: 'ada' });
  assert.deepEqual(again.body, { hearted: true, hearts: 2 });
  assert.deepEqual(tinylytics!.kudosKept, [
    { path: '/signs/exit-seven', uid: 'web-visitor' },
    { path: '/signs/exit-seven', uid: heartUid(ada.id, EXIT) }
  ]);
  assert.equal(tinylytics!.calls.filter((c) => c === 'addKudo').length, 1);
  assert.deepEqual(
    (await store.listHearts(ada.id)).map((h) => [h.signId, h.uid]),
    [[EXIT, heartUid(ada.id, EXIT)]]
  );

  // Ben's heart adds to theirs.
  const bens = await call('PUT', '/signs/exit-seven/heart', { as: 'ben' });
  assert.deepEqual(bens.body, { hearted: true, hearts: 3 });

  const off = await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' });
  assert.deepEqual(off.body, { hearted: false, hearts: 2 });
  const offAgain = await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' });
  assert.deepEqual(offAgain.body, { hearted: false, hearts: 2 });
  assert.equal(tinylytics!.calls.filter((c) => c === 'removeKudo').length, 1);
  assert.deepEqual(await store.listHearts(ada.id), []);
});

test('the uid is the same for a player and a sign, and names neither', () => {
  const uid = heartUid(ada.id, EXIT);
  assert.equal(uid, heartUid(ada.id, EXIT));
  assert.notEqual(uid, heartUid(ben.id, EXIT));
  assert.notEqual(uid, heartUid(ada.id, BENS));
  assert.match(uid, /^rsm-[0-9a-f]{32}$/);
  assert.ok(!uid.includes(ada.id) && !uid.includes(EXIT));
});

test('every sign carries its hearts, and a signed-in reader whether they hearted it', async () => {
  const { tinylytics, call } = await setup();
  tinylytics!.kudosKept.push({ path: '/signs/bens-sign', uid: 'web-1' }, { path: '/signs/bens-sign', uid: 'web-2' });
  await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });

  const anon = await call('GET', '/signs');
  const byTitle = (signs: Json[]) => Object.fromEntries(signs.map((s) => [s.title, [s.hearts, s.hearted]]));
  assert.deepEqual(byTitle(anon.body.signs), { 'Bens Sign': [2, null], 'Exit Seven': [1, null] });
  assert.equal(anon.res.headers.get('cache-control'), 'public, max-age=60');

  const mine = await call('GET', '/signs', { as: 'ada' });
  assert.deepEqual(byTitle(mine.body.signs), {
    'Bens Sign': [2, false],
    'Exit Seven': [1, true],
    'Held Sign': [0, false]
  });
  assert.equal(mine.res.headers.get('cache-control'), 'no-store');

  const one = await call('GET', '/signs/exit-seven', { as: 'ada' });
  assert.deepEqual([one.body.hearts, one.body.hearted], [1, true]);
  const map = await call('GET', '/map', { as: 'ben' });
  assert.deepEqual(
    map.body.pins.map((p: Json) => [p.slug, p.hearts, p.hearted]),
    [
      ['bens-sign', 2, false],
      ['exit-seven', 1, false]
    ]
  );
  const player = await call('GET', '/players/ada');
  assert.deepEqual(
    player.body.signs.map((s: Json) => s.hearts),
    [2, 1]
  );
  const near = await call('GET', '/signs/near?lat=44.9&lng=-93.2');
  assert.ok(near.body.signs.every((s: Json) => typeof s.hearts === 'number'));
  // One read of the site's kudos served all of these.
  assert.equal(tinylytics!.reads, 1);
});

test('without a key hearts are off: counts are null and hearting is a 503 that changes nothing', async () => {
  const tinylytics = new FakeTinylytics();
  tinylytics.state = 'off';
  const { store, call } = await setup(tinylytics);
  const feed = await call('GET', '/signs');
  assert.equal(feed.res.status, 200);
  assert.ok(feed.body.signs.every((s: Json) => s.hearts === null && s.hearted === null));
  const put = await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(put.res.status, 503);
  assert.equal(put.body.error.code, 'unavailable');
  assert.deepEqual(await store.listHearts(ada.id), []);
  assert.equal((await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' })).body.hearted, false);
});

test('with no Tinylytics at all the server answers the same way', async () => {
  const { call } = await setup(null);
  const one = await call('GET', '/signs/exit-seven');
  assert.deepEqual([one.body.hearts, one.body.hearted], [null, null]);
  assert.equal((await call('PUT', '/signs/exit-seven/heart', { as: 'ada' })).res.status, 503);
});

test('a heart Tinylytics fails to count is taken back whole', async () => {
  const { store, tinylytics, call } = await setup();
  tinylytics!.failing.add('addKudo');
  const put = await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(put.res.status, 503);
  assert.deepEqual(await store.listHearts(ada.id), []);
  // The kudo is removed too, in case it was made after all.
  assert.deepEqual(tinylytics!.calls.slice(-2), ['addKudo', 'removeKudo']);

  tinylytics!.failing.clear();
  await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  tinylytics!.failing.add('removeKudo');
  const off = await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(off.res.status, 503);
  // Still hearted, and still counted.
  assert.equal((await store.listHearts(ada.id)).length, 1);
  assert.equal(tinylytics!.kudosKept.length, 1);
});

test('a heart that may have been counted and can’t be taken back stays, for a later DELETE', async () => {
  const { store, tinylytics, call } = await setup();
  tinylytics!.failing.add('addKudo');
  tinylytics!.failing.add('removeKudo');
  assert.equal((await call('PUT', '/signs/exit-seven/heart', { as: 'ada' })).res.status, 503);
  assert.equal((await store.listHearts(ada.id)).length, 1);
  assert.equal((await call('GET', '/signs/exit-seven', { as: 'ada' })).body.hearted, true);

  tinylytics!.failing.clear();
  const off = await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(off.res.status, 200);
  assert.deepEqual(await store.listHearts(ada.id), []);
});

test('the same player’s two changes to one heart don’t cross', async () => {
  const { store, tinylytics, call } = await setup();
  let go!: () => void;
  tinylytics!.pause = new Promise((resolve) => (go = resolve));
  const put = call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  while (!tinylytics!.calls.includes('addKudo')) await new Promise((r) => setImmediate(r));
  const off = await call('DELETE', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(off.res.status, 409);
  go();
  assert.equal((await put).res.status, 200);
  assert.equal((await store.listHearts(ada.id)).length, 1);
  assert.equal(tinylytics!.kudosKept.length, 1);
});

test('only a shown sign the reader can see takes a heart, and only signed in', async () => {
  const { store, call } = await setup();
  assert.equal((await call('PUT', '/signs/exit-seven/heart')).res.status, 401);
  const held = await call('PUT', '/signs/held-sign/heart', { as: 'ada' });
  assert.equal(held.res.status, 400);
  assert.equal((await call('PUT', '/signs/held-sign/heart', { as: 'ben' })).res.status, 404);
  assert.equal((await call('PUT', '/signs/nope/heart', { as: 'ada' })).res.status, 404);

  // A heart given before a block can still be taken back.
  assert.equal((await call('PUT', '/signs/bens-sign/heart', { as: 'ada' })).res.status, 200);
  await call('POST', '/players/ben/block', { as: 'ada' });
  assert.equal((await call('GET', '/signs/bens-sign', { as: 'ada' })).res.status, 404);
  const off = await call('DELETE', '/signs/bens-sign/heart', { as: 'ada' });
  assert.equal(off.res.status, 200);
  assert.equal(off.body.hearted, false);
  assert.deepEqual(await store.listHearts(ada.id), []);
  assert.equal((await call('DELETE', '/signs/bens-sign/heart', { as: 'ada' })).res.status, 404);
});

test('hearting has a daily limit', async () => {
  const { store, call } = await setup();
  const day = nowSeconds() - (nowSeconds() % 86400);
  for (let i = 0; i < LIMITS.heartsADay; i++) await store.bump(`hearts:${ada.id}`, 86400, day + 1);
  const res = await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  assert.equal(res.res.status, 429);
});

test('deleting an account takes back every heart it gave, and every heart on its signs', async () => {
  const { store, tinylytics, call } = await setup();
  await call('PUT', '/signs/exit-seven/heart', { as: 'ben' });
  await call('PUT', '/signs/bens-sign/heart', { as: 'ben' });
  await call('PUT', '/signs/bens-sign/heart', { as: 'ada' });
  tinylytics!.kudosKept.push({ path: '/signs/bens-sign', uid: 'web-1' });

  tinylytics!.state = 'down';
  const failed = await call('DELETE', '/me', { as: 'ben' });
  assert.equal(failed.res.status, 503);
  assert.ok(await store.getPlayer(ben.id), 'nothing is deleted when a heart can’t be taken back');
  assert.ok(await store.getSign(BENS));

  tinylytics!.state = 'up';
  assert.equal((await call('DELETE', '/me', { as: 'ben' })).res.status, 204);
  assert.equal(await store.getPlayer(ben.id), undefined);
  assert.deepEqual(await store.listHearts(ben.id), []);
  // Ada's heart on Exit Seven is all that's left; Ben's sign's hearts went with it.
  assert.deepEqual(tinylytics!.kudosKept, []);
  await call('PUT', '/signs/exit-seven/heart', { as: 'ada' });
  assert.deepEqual(tinylytics!.kudosKept, [{ path: '/signs/exit-seven', uid: heartUid(ada.id, EXIT) }]);
});

test('without a key an account still goes, with its rows', async () => {
  const { store, tinylytics, call } = await setup();
  await call('PUT', '/signs/exit-seven/heart', { as: 'ben' });
  tinylytics!.state = 'off';
  assert.equal((await call('DELETE', '/me', { as: 'ben' })).res.status, 204);
  assert.deepEqual(await store.listHearts(ben.id), []);
});

test('deleting a sign removes its hearts, the website’s too, so a new sign with its slug starts at none', async () => {
  const { store, tinylytics, call } = await setup();
  await call('PUT', '/signs/exit-seven/heart', { as: 'ben' });
  tinylytics!.kudosKept.push({ path: '/signs/exit-seven', uid: 'web-1' }, { path: '/signs/bens-sign', uid: 'web-2' });
  tinylytics!.state = 'down';
  assert.equal((await call('DELETE', '/signs/exit-seven', { as: 'ada' })).res.status, 503);
  assert.ok(await store.getSign(EXIT));
  tinylytics!.state = 'up';
  assert.equal((await call('DELETE', '/signs/exit-seven', { as: 'ada' })).res.status, 204);
  assert.deepEqual(tinylytics!.kudosKept, [{ path: '/signs/bens-sign', uid: 'web-2' }]);
});

test('heart counts are read once a minute and kept through a short outage', async () => {
  const tinylytics = new FakeTinylytics();
  tinylytics.kudosKept.push(
    { path: '/signs/a', uid: '1' },
    { path: '/signs/a', uid: '2' },
    { path: '/signs/b', uid: '3' }
  );
  let now = 1_000_000;
  const counts = new HeartCounts(tinylytics, () => now);
  assert.deepEqual(
    [...(await counts.counts())!],
    [
      ['/signs/a', 2],
      ['/signs/b', 1]
    ]
  );
  now += 30_000;
  await counts.counts();
  assert.equal(tinylytics.reads, 1);
  // A change this server made after the read is added; one the read already had is not.
  counts.adjust('/signs/b', 1, now);
  counts.adjust('/signs/a', 1, 999_999);
  assert.deepEqual(
    [...(await counts.counts())!],
    [
      ['/signs/a', 2],
      ['/signs/b', 2]
    ]
  );
  now += 61_000;
  tinylytics.state = 'down';
  assert.equal((await counts.counts())!.get('/signs/b'), 2, 'the last counts while Tinylytics is down');
  assert.equal(tinylytics.calls.filter((c) => c === 'kudos').length, 2);
  await counts.counts();
  assert.equal(tinylytics.calls.filter((c) => c === 'kudos').length, 2, 'not asked again straight away');
  now += 10 * 60_000;
  assert.equal(await counts.counts(), undefined, 'too old to show');
});

test('the app’s views go to Tinylytics as the app’s, with its User-Agent and country and nothing else', async () => {
  const { tinylytics, call } = await setup();
  const headers = { 'user-agent': 'RoadSignMath/1.0 CFNetwork Darwin', 'cloudfront-viewer-country': 'US' };
  const res = await call('POST', '/app/views', {
    body: { views: [{ path: '/' }, { path: '/signs/exit-seven' }, { path: '/capture' }] },
    headers
  });
  assert.equal(res.res.status, 202);
  assert.deepEqual(res.body, { accepted: 3 });
  assert.deepEqual(tinylytics!.hits, [
    [
      { path: '/', userAgent: headers['user-agent'], country: 'US' },
      { path: '/signs/exit-seven', userAgent: headers['user-agent'], country: 'US' },
      { path: '/capture', userAgent: headers['user-agent'], country: 'US' }
    ]
  ]);
  // Signed in, it says no more about who.
  await call('POST', '/app/views', {
    as: 'ada',
    body: { views: [{ path: '/map' }] },
    headers: { 'cloudfront-viewer-country': 'zz9' }
  });
  assert.deepEqual(tinylytics!.hits[1], [{ path: '/map', userAgent: undefined, country: undefined }]);
});

test('app views are checked, and dropped quietly when Tinylytics can’t take them', async () => {
  const { tinylytics, call } = await setup();
  const bad = [
    {},
    { views: [] },
    { views: Array.from({ length: LIMITS.viewsMax + 1 }, () => ({ path: '/' })) },
    { views: [{ path: 'map' }] },
    { views: [{ path: '/Map' }] },
    { views: [{ path: '/signs/a/b' }] },
    { views: [{ path: '/signs/a?x=1' }] },
    { views: [{ path: '/me', visitor: 'x' }] },
    { views: [{ path: `/${'a'.repeat(81)}` }] },
    { views: ['/'] },
    { views: [{ path: '/' }], player: 'ada' }
  ];
  for (const body of bad) {
    const res = await call('POST', '/app/views', { body });
    assert.equal(res.res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(tinylytics!.hits, []);
  tinylytics!.state = 'down';
  const down = await call('POST', '/app/views', { body: { views: [{ path: '/' }] } });
  assert.equal(down.res.status, 202);
  tinylytics!.state = 'off';
  assert.equal((await call('POST', '/app/views', { body: { views: [{ path: '/' }] } })).res.status, 202);
});

test('app views are limited per network', async () => {
  const { store, call } = await setup();
  const hour = nowSeconds() - (nowSeconds() % 3600);
  for (let i = 0; i < LIMITS.viewBatchesAnHour; i++) await store.bump('views:192.0.2.1', 3600, hour + 1);
  const res = await call('POST', '/app/views', { body: { views: [{ path: '/' }] } });
  assert.equal(res.res.status, 429);
});
