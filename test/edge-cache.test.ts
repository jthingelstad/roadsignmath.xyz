import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { MemoryEdgeCache, PAGE_CACHE, PageChanges, POPULAR_CACHE, type EdgeCache } from '../src/edge-cache.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SECRET = 'ada'.padEnd(43, 'x');
const TOKEN = `rsm_${ada.id}_${SECRET}`;

async function setup(cache: EdgeCache = new MemoryEdgeCache()) {
  // Filled before the app wraps it, so none of this counts as a change.
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await store.putSession({
    playerId: ada.id,
    secretHash: createHash('sha256').update(SECRET).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: new Date().toISOString(),
    expiresAt: nowSeconds() + 3600
  });
  await store.putSign(sign({ id: '01JS0000000000000000000001', title: 'Exit Seven' }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    edgeCache: cache
  });
  const call = (method: string, path: string, body?: unknown, raw?: Buffer) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(raw ? { 'content-type': 'image/jpeg' } : body ? { 'content-type': 'application/json' } : {})
      },
      body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined
    });
  return { app, store, call };
}

test('pages are kept a day at the edge, Popular six hours, and the API a minute', async () => {
  const { app } = await setup();
  for (const path of ['/', '/signs', '/players', '/signs.json', '/feed.xml', '/about']) {
    assert.equal((await app.request(path)).headers.get('cache-control'), PAGE_CACHE, path);
  }
  assert.equal(PAGE_CACHE, 'public, max-age=60, s-maxage=86400');
  assert.equal(POPULAR_CACHE, 'public, max-age=60, s-maxage=21600');
  for (const path of ['/?sort=popular', '/signs?sort=popular&year=2026']) {
    assert.equal((await app.request(path)).headers.get('cache-control'), POPULAR_CACHE, path);
  }
  assert.equal((await app.request('/api/v1/signs')).headers.get('cache-control'), 'public, max-age=60');
});

test('a missing page is kept at the edge like any page; a missing API route is not', async () => {
  const { app } = await setup();
  for (const path of ['/no-such-page', '/.env', '/signs/nothing-here', '/players/nobody', '/players/nobody/feed.xml']) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('cache-control'), PAGE_CACHE, path);
  }
  const api = await app.request('/api/no-such-route');
  assert.equal(api.status, 404);
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('a missing page made without the newest signs is not kept', async () => {
  const { app, store } = await setup();
  const logged = console.error;
  console.error = () => {};
  store.allSigns = async () => {
    throw new Error('table down');
  };
  try {
    const res = await app.request('/no-such-page');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    console.error = logged;
  }
});

test('reading clears nothing; a request that changes a page clears the edge once', async () => {
  const cache = new MemoryEdgeCache();
  const { app, call } = await setup(cache);
  await app.request('/');
  await app.request('/signs');
  await call('GET', '/api/v1/me');
  assert.equal(cache.clears, 0);

  const renamed = await call('PATCH', '/api/v1/me', { bio: 'Counts signs.' });
  assert.equal(renamed.status, 200);
  assert.equal(cache.clears, 1);

  // A post writes the sign several times over; it still clears once, after the last write.
  const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#f2b300' } })
    .jpeg()
    .toBuffer();
  const uploaded = await call('POST', '/api/v1/photos', undefined, photo);
  assert.equal(uploaded.status, 201);
  assert.equal(cache.clears, 1, 'an upload shows on no page');
  const { id } = (await uploaded.json()) as { id: string };
  const posted = await call('POST', '/api/v1/signs', {
    photo_ids: [id],
    title: 'Exit 7',
    numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
    place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
    found_on: '2026-06-01',
    way: '7 + 12 = 19'
  });
  assert.equal(posted.status, 201, await posted.clone().text());
  assert.equal(cache.clears, 2);
});

test('a clear that fails is logged and the request still answers', async () => {
  const failing: EdgeCache = {
    clear: async () => {
      throw Object.assign(new Error('nope'), { name: 'AccessDenied' });
    }
  };
  const { call } = await setup(failing);
  assert.equal((await call('PATCH', '/api/v1/me', { bio: 'Still counts.' })).status, 200);
});

test('a page write outside a request clears at once; other writes and reads never do', async () => {
  const cache = new MemoryEdgeCache();
  const store = new PageChanges(cache).watch(new MemoryStore());
  await store.allSigns();
  await store.bump('limit', 60, nowSeconds());
  assert.equal(cache.clears, 0);
  await store.putSign(sign({ id: '01JS0000000000000000000009', title: 'Exit Nine' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.clears, 1);
  assert.equal((await store.allSigns()).length, 1);
});
