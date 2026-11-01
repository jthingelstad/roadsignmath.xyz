import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { byComplexity, signComplexity, wayComplexity } from '../src/domain/complexity.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

test('each operator counts once, weighted by how hard it is', () => {
  assert.equal(wayComplexity('7 + 12 = 19'), 1);
  assert.equal(wayComplexity('20 − 1 = 19'), 1);
  assert.equal(wayComplexity('3 × 33 = 99'), 2);
  assert.equal(wayComplexity('6 ÷ 3 = 2'), 3);
  assert.equal(wayComplexity('−2 + 4 = 2'), 3);
  assert.equal(wayComplexity('√4 = 2'), 4);
  assert.equal(wayComplexity('2 ^ 3 = 8'), 4);
  assert.equal(wayComplexity('3! = 6'), 5);
  // Brackets and = count nothing; every side counts.
  assert.equal(wayComplexity('(7 + 7) + (3 × 2) = 19 + 1'), 5);
  assert.equal(wayComplexity('√(83 − √4) = 6 + 3'), 10);
  assert.equal(wayComplexity('2 = 2'), 0);
  assert.equal(wayComplexity('not math'), 0);
});

test('a harder operator outweighs an easier one', () => {
  const order = ['1 + 1 = 2', '2 × 1 = 2', '2 ÷ 1 = 2', '√4 = 2', '2! = 2'].map(wayComplexity);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  );
  assert.ok(new Set(order).size >= 4);
});

test('a sign is its most complex way, and an unsolved sign is 0', () => {
  assert.equal(signComplexity([{ text: '7 + 12 = 19' }, { text: '√(5 − 1) = 2' }]), 5);
  assert.equal(signComplexity([]), 0);
});

test('byComplexity: most complex first, ties keep their order, unsolved last', () => {
  const signs = [{ id: 'new' }, { id: 'unsolved' }, { id: 'tie' }, { id: 'hard' }];
  const ways = new Map([
    ['new', [{ text: '7 + 12 = 19' }]],
    ['tie', [{ text: '20 − 1 = 19' }]],
    ['hard', [{ text: '7 + 12 = 19' }, { text: '3! + 13 = 19' }]]
  ]);
  assert.deepEqual(
    byComplexity(signs, ways).map((s) => s.id),
    ['hard', 'new', 'tie', 'unsolved']
  );
});

const PLAIN = '01JS0000000000000000000001';
const HARD = '01JS0000000000000000000002';
const NONE = '01JS0000000000000000000003';
const HELD = '01JS0000000000000000000004';

async function setup() {
  const store = new MemoryStore();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1'
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
  // Newest first: Nobody Solved, then Hard Math, then Plain Math.
  await addSign(store, sign({ id: PLAIN, title: 'Plain Math', postedAt: '2026-01-01T00:00:00.000Z' }));
  await addSign(store, sign({ id: HARD, title: 'Hard Math', postedAt: '2026-02-01T00:00:00.000Z' }));
  await addSign(
    store,
    sign({ id: NONE, title: 'Nobody Solved', postedAt: '2026-03-01T00:00:00.000Z', firstWay: undefined, wayCount: 0 })
  );
  await addSign(store, sign({ id: HELD, title: 'Held Math', visibility: 'held' }));
  await store.addWay(way(PLAIN, { id: 'W1', text: '7 + 12 = 19' }));
  await store.addWay(way(HARD, { id: 'W2', text: '7 + 12 = 19' }));
  await store.addWay(way(HARD, { id: 'W3', playerId: ben.id, text: '√(7 + 12 − 19 + 4) = 2', value: '2' }));
  await store.addWay(way(HELD, { id: 'W4', text: '3! + 13 = 19' }));
  const call = async (path: string, as?: string) => {
    const headers: Record<string, string> = as ? { authorization: `Bearer ${tokens[as]}` } : {};
    const res = await app.request(`/api/v1${path}`, { headers });
    return { res, body: (await res.json()) as Json };
  };
  return { store, call };
}

test('GET /signs/complex: the most complex first, the unsolved last, held signs never', async () => {
  const { call } = await setup();
  const { res, body } = await call('/signs/complex');
  assert.equal(res.status, 200);
  assert.deepEqual(
    body.signs.map((s: Json) => [s.slug, s.complexity]),
    [
      ['hard-math', 7],
      ['plain-math', 1],
      ['nobody-solved', 0]
    ]
  );
  assert.equal(typeof body.signs[0].title, 'string');
});

test('GET /signs/complex leaves out the ways of a player the reader blocked', async () => {
  const { store, call } = await setup();
  await store.putBlock({ playerId: ada.id, blockedId: ben.id, createdAt: '2026-04-01T00:00:00.000Z' });
  const { res, body } = await call('/signs/complex', 'ada');
  assert.equal(res.status, 200);
  // Without Ben's root, Hard Math ties Plain Math and stays ahead as the newer. Ada also sees
  // her own held sign, as she does in every list.
  assert.deepEqual(
    body.signs.map((s: Json) => [s.slug, s.complexity]),
    [
      ['held-math', 6],
      ['hard-math', 1],
      ['plain-math', 1],
      ['nobody-solved', 0]
    ]
  );
});
