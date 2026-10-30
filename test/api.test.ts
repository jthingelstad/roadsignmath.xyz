import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { API_VERSION, LIMITS, ROUTES } from '../src/api/contract.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await addPlayer(store, ben);
  await store.putSign(
    sign({
      id: '01JS0000000000000000000001',
      title: 'First Sign',
      postedAt: '2026-01-01T00:00:00.000Z',
      foundOn: '2025-12-31'
    })
  );
  await store.putSign(
    sign({
      id: '01JS0000000000000000000002',
      title: 'Far Away',
      postedAt: '2026-02-01T00:00:00.000Z',
      place: { label: 'Testburg, Vermont', state: 'VT', lat: 44.26, lng: -72.58, approximate: true },
      finders: [
        { playerId: ben.id, name: ben.name, role: 'took_photo' },
        { name: 'A friend', role: 'spotted' }
      ],
      postedBy: ben.id
    })
  );
  await store.putSign(
    sign({
      id: '01JS0000000000000000000003',
      title: 'No Pin',
      postedAt: '2026-03-01T00:00:00.000Z',
      place: { label: 'Somewhere on I-90', approximate: true }
    })
  );
  await store.putSign(sign({ id: '01JS0000000000000000000004', title: 'Held Back', visibility: 'held' }));
  await store.putWay(way('01JS0000000000000000000001', { id: 'w1', createdAt: '2026-01-01T00:00:00.000Z' }));
  await store.putWay(
    way('01JS0000000000000000000001', {
      id: 'w2',
      playerId: ben.id,
      text: '19 − 12 = 7',
      value: '7',
      createdAt: '2026-01-05T00:00:00.000Z'
    })
  );
  const app = createApp({ store, urls: { site: 'https://example.test' }, mailer: new MemoryMailer() });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { res, body: (await res.json()) as Json };
  };
  return { store, app, get };
}

test('index counts only public signs and the players who found them', async () => {
  const { get } = await setup();
  const { res, body } = await get('/api/v1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('API-Version'), API_VERSION);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  assert.deepEqual(body, {
    api_version: API_VERSION,
    signs: 3,
    players: 2,
    states: 2,
    openapi_url: 'https://example.test/api/v1/openapi.json'
  });
});

test('the feed pages newest first and leaves out held signs', async () => {
  const { get } = await setup();
  const first = await get('/api/v1/signs?limit=2');
  assert.deepEqual(
    first.body.signs.map((s: Json) => s.title),
    ['No Pin', 'Far Away']
  );
  assert.ok(first.body.next_cursor);
  const second = await get(`/api/v1/signs?limit=2&cursor=${first.body.next_cursor}`);
  assert.deepEqual(
    second.body.signs.map((s: Json) => s.title),
    ['First Sign']
  );
  assert.equal(second.body.next_cursor, null);
});

test('a sign reads in snake_case with urls, handles and no emails', async () => {
  const { get } = await setup();
  const { body } = await get('/api/v1/signs/first-sign');
  assert.equal(body.id, '01JS0000000000000000000001');
  assert.equal(body.url, 'https://example.test/signs/first-sign');
  assert.equal(body.posted_by, 'ada');
  assert.equal(body.found_on, '2025-12-31');
  assert.equal(body.photos[0].thumb_url, 'https://example.test/p/ph-01JS0000000000000000000001/thumb.jpg');
  assert.deepEqual(body.numbers[0], { value: '7', text: '7', why: null, box: null });
  assert.deepEqual(
    body.ways.map((w: Json) => [w.id, w.by.handle]),
    [
      ['w1', 'ada'],
      ['w2', 'ben']
    ]
  );
  assert.ok(!JSON.stringify(body).includes('@example.com'));
  const byId = await get('/api/v1/signs/01JS0000000000000000000001');
  assert.equal(byId.body.slug, 'first-sign');
});

test('finders without an account have no handle', async () => {
  const { get } = await setup();
  const { body } = await get('/api/v1/signs/far-away');
  assert.deepEqual(body.finders, [
    { name: 'Ben', handle: 'ben', role: 'took_photo' },
    { name: 'A friend', handle: null, role: 'spotted' }
  ]);
});

test('held signs and unknown ids are not found', async () => {
  const { get } = await setup();
  for (const path of ['/api/v1/signs/held-back', '/api/v1/signs/nope', '/api/v1/players/nobody']) {
    const { res, body } = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(body.error.code, 'not_found');
    assert.equal(res.headers.get('API-Version'), API_VERSION);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  const { res, body } = await get('/api/v1/nothing/here');
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'not_found');
});

test('near sorts by miles and skips signs with no pin', async () => {
  const { get } = await setup();
  const { body } = await get('/api/v1/signs/near?lat=44.97&lng=-93.26');
  assert.deepEqual(
    body.signs.map((s: Json) => s.title),
    ['First Sign', 'Far Away']
  );
  assert.ok(body.signs[0].miles < 2);
  assert.ok(body.signs[1].miles > 1000);
});

test('similar finds a nearby sign sharing half the numbers', async () => {
  const { get } = await setup();
  const hit = await get('/api/v1/signs/similar?lat=44.98&lng=-93.27&numbers=07,12,40,41');
  assert.deepEqual(
    hit.body.signs.map((s: Json) => s.title),
    ['First Sign']
  );
  const miss = await get('/api/v1/signs/similar?lat=44.98&lng=-93.27&numbers=7,40,41');
  assert.deepEqual(miss.body.signs, []);
});

test('bad parameters are 400s that say which', async () => {
  const { get } = await setup();
  const cases: [string, RegExp][] = [
    ['/api/v1/signs/near?lat=100&lng=0', /lat/],
    ['/api/v1/signs/near?lng=0', /lat is required/],
    ['/api/v1/signs?limit=0', /limit/],
    [`/api/v1/signs?limit=${LIMITS.pageMax + 1}`, /limit/],
    ['/api/v1/signs?cursor=garbage', /cursor/],
    ['/api/v1/signs/similar?lat=1&lng=1&numbers=', /numbers is required/],
    ['/api/v1/signs/similar?lat=1&lng=1&numbers=7,x', /plain numbers/]
  ];
  for (const [path, message] of cases) {
    const { res, body } = await get(path);
    assert.equal(res.status, 400, path);
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, message);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});

test('map has every public sign and its years', async () => {
  const { get } = await setup();
  const { body } = await get('/api/v1/map');
  assert.equal(body.pins.length, 3);
  assert.deepEqual(body.years, [2025, 2026]);
  const noPin = body.pins.find((p: Json) => p.title === 'No Pin');
  assert.equal(noPin.lat, null);
});

test('players: latest sign first, stats from the signs they found', async () => {
  const { get } = await setup();
  const { body } = await get('/api/v1/players');
  assert.deepEqual(
    body.players.map((p: Json) => [p.handle, p.sign_count, p.states, p.first_year]),
    [
      ['ada', 2, ['MN'], 2025],
      ['ben', 1, ['VT'], 2026]
    ]
  );
  const one = await get('/api/v1/players/ben');
  assert.deepEqual(
    one.body.signs.map((s: Json) => s.title),
    ['Far Away']
  );
  assert.ok(!('email' in one.body));
});

test('every route in the contract answers', async () => {
  const { app } = await setup();
  for (const route of ROUTES) {
    const path = route.path.replace('{id}', 'first-sign').replace('{handle}', 'ada');
    const query = route.params.some((p) => p.name === 'numbers')
      ? '?lat=44.98&lng=-93.27&numbers=7,12'
      : route.params.some((p) => p.name === 'lat')
        ? '?lat=44.98&lng=-93.27'
        : '';
    const res = await app.request(`/api/v1${path}${query}`, { method: route.method.toUpperCase() });
    // Public reads answer; the rest refuse a request with no token or no body, but they're there.
    const expected = route.auth === 'signed_in' ? 401 : route.body ? 400 : 200;
    assert.equal(res.status, expected, route.operationId);
  }
});
