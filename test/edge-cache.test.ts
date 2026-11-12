import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import {
  CLEAR_LEASE,
  MemoryEdgeCache,
  OWED_LEASE,
  OWED_SWEEP_MS,
  PAGE_CACHE,
  PageChanges,
  POPULAR_CACHE,
  TRAILING_CLEAR_MS,
  type EdgeCache
} from '../src/edge-cache.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SECRET = 'ada'.padEnd(43, 'x');
const TOKEN = `rsm_${ada.id}_${SECRET}`;

async function setup(cache: EdgeCache = new MemoryEdgeCache(), store = new MemoryStore()) {
  // Filled before the app wraps it, so none of this counts as a change.
  await addPlayer(store, ada);
  await store.putSession({
    playerId: ada.id,
    secretHash: createHash('sha256').update(SECRET).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: new Date().toISOString(),
    expiresAt: nowSeconds() + 3600
  });
  if (!(await store.getSign('01JS0000000000000000000001')))
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
  for (const path of ['/signs?sort=popular', '/signs?sort=popular&year=2026']) {
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

/** Runs `body` on a clock the test moves: timers, and the time the leases read. */
async function onTestClock(body: () => Promise<void>) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-12T18:00:00Z') });
  try {
    await body();
  } finally {
    mock.timers.reset();
  }
}

/** Moves the clock and lets what the timers started finish. */
async function wait(ms: number) {
  mock.timers.tick(ms);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('reading clears nothing; a request that changes a page clears the edge once', () =>
  onTestClock(async () => {
    const cache = new MemoryEdgeCache();
    const { app, call } = await setup(cache);
    await app.request('/');
    await app.request('/signs');
    await call('GET', '/api/v1/me');
    assert.equal(cache.clears, 0);

    const renamed = await call('PATCH', '/api/v1/me', { bio: 'Counts signs.' });
    assert.equal(renamed.status, 200);
    assert.equal(cache.clears, 1);
    // Sending nothing, or what is already kept, writes nothing: no page changed, so none is cleared.
    for (const same of [{}, { bio: 'Counts signs.' }, { bio: '  Counts   signs. ' }]) {
      assert.equal((await call('PATCH', '/api/v1/me', same)).status, 200, JSON.stringify(same));
    }
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
    // Inside the minute of the last clear: owed, and cleared once the minute is over.
    assert.equal(cache.clears, 1);
    await wait(TRAILING_CLEAR_MS);
    assert.equal(cache.clears, 2);
  }));

test('a burst of writes clears at once and once more after the minute, never more often', () =>
  onTestClock(async () => {
    const cache = new MemoryEdgeCache();
    const { call } = await setup(cache);
    const bio = (n: number) => call('PATCH', '/api/v1/me', { bio: `Counts signs ${n}.` });
    assert.equal((await bio(1)).status, 200);
    assert.equal(cache.clears, 1, 'the first write after a quiet spell clears at once');
    for (let n = 2; n <= 6; n++) {
      await wait(5_000);
      assert.equal((await bio(n)).status, 200);
    }
    assert.equal(cache.clears, 1, 'nothing more inside the minute');
    await wait(TRAILING_CLEAR_MS - 1);
    assert.equal(cache.clears, 1);
    await wait(1);
    assert.equal(cache.clears, 2, 'the trailing clear covers the last write');
    await wait(TRAILING_CLEAR_MS * 3);
    assert.equal(cache.clears, 2, 'and nothing is left owed');
  }));

test('the minute holds across environments, and the last write is still cleared', () =>
  onTestClock(async () => {
    // Two environments of the function share the table, each with its own process.
    const store = new MemoryStore();
    const a = new MemoryEdgeCache();
    const b = new MemoryEdgeCache();
    const one = await setup(a, store);
    const two = await setup(b, store);
    assert.equal((await one.call('PATCH', '/api/v1/me', { bio: 'From one.' })).status, 200);
    await wait(20_000);
    assert.equal((await two.call('PATCH', '/api/v1/me', { bio: 'From two.' })).status, 200);
    assert.equal(a.clears + b.clears, 1);
    await wait(TRAILING_CLEAR_MS);
    assert.deepEqual([a.clears, b.clears], [1, 1], 'the second environment clears after the minute');
    await wait(TRAILING_CLEAR_MS * 3);
    assert.equal(a.clears + b.clears, 2);
  }));

test('a clear owed by an environment that went away is sent from another', () =>
  onTestClock(async () => {
    const store = new MemoryStore();
    const cache = new MemoryEdgeCache();
    const { app } = await setup(cache, store);
    // What an environment stopped before its timer leaves behind: a clear in the minute, and one owed.
    await store.lease(CLEAR_LEASE, 'gone', 60);
    await store.lease(OWED_LEASE, 'owed', 86_400);
    await app.request('/');
    assert.equal(cache.clears, 0, 'not inside the minute');
    await wait(OWED_SWEEP_MS);
    await app.request('/signs');
    assert.equal(cache.clears, 1, 'the next look after the minute sends it');
    await wait(OWED_SWEEP_MS * 3);
    await app.request('/');
    assert.equal(cache.clears, 1, 'once');
  }));

test('a clear that fails is owed and tried again', () =>
  onTestClock(async () => {
    let fail = true;
    let clears = 0;
    const flaky: EdgeCache = {
      clear: async () => {
        if (fail) throw Object.assign(new Error('nope'), { name: 'ServiceUnavailable' });
        clears += 1;
      }
    };
    const logged = console.error;
    console.error = () => {};
    try {
      const { app, call } = await setup(flaky);
      assert.equal((await call('PATCH', '/api/v1/me', { bio: 'Still counts.' })).status, 200);
      fail = false;
      await wait(OWED_SWEEP_MS);
      await app.request('/');
      assert.equal(clears, 1);
    } finally {
      console.error = logged;
    }
  }));

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
