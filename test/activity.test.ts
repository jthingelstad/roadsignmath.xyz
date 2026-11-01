import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const player = (letter: string, name: string, avatarColor: string, extra: Partial<Player> = {}): Player => ({
  id: `01J${letter.repeat(23)}`,
  handle: name.toLowerCase() || `p${letter.toLowerCase().repeat(10)}`,
  name,
  avatarColor,
  createdAt: '2026-01-03T00:00:00.000Z',
  ...extra
});
const cy = player('C', 'Cy', '#F2B300', { avatar: 'avatar-cy' });
const dee = player('D', 'Dee', '#B01C33');
/** Ada blocked Eve. */
const eve = player('E', 'Eve', '#18201C');
/** Signed in, no name yet. */
const fay = player('F', '', '#006348');

const id = (n: number) => `01JS${String(n).padStart(22, '0')}`;
const ago = (days: number, minutes = 0) => new Date(Date.now() - days * 86400_000 - minutes * 60_000).toISOString();

/**
 * Ada's signs: one she posted and found (Exit Seven), one she posted that is held (Held Up),
 * and Ben's post that names her a finder (Ben Found). Ben's Own is Ben's alone, and Ben's Held
 * is held with Ada among its finders.
 */
async function setup() {
  const store = new MemoryStore();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const tokens: Record<string, string> = {};
  for (const p of [ada, ben, cy, dee, eve, fay]) {
    await addPlayer(store, p);
    const secret = p.id.toLowerCase().padEnd(43, 'x');
    await store.putSession({
      playerId: p.id,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: new Date().toISOString(),
      expiresAt: nowSeconds() + 3600
    });
    tokens[p.id] = `rsm_${p.id}_${secret}`;
  }
  const withAda = [
    { playerId: ben.id, name: ben.name, role: 'took_photo' as const },
    { playerId: ada.id, name: ada.name, role: 'spotted' as const }
  ];
  await addSign(store, sign({ id: id(1), title: 'Exit Seven' }));
  await addSign(store, sign({ id: id(2), title: 'Held Up', visibility: 'held' }));
  await addSign(store, sign({ id: id(3), title: 'Ben Found', postedBy: ben.id, finders: withAda }));
  await addSign(
    store,
    sign({
      id: id(4),
      title: 'Bens Own',
      postedBy: ben.id,
      finders: [{ playerId: ben.id, name: ben.name, role: 'found' }]
    })
  );
  await addSign(store, sign({ id: id(5), title: 'Bens Held', postedBy: ben.id, finders: withAda, visibility: 'held' }));
  await store.putBlock({ playerId: ada.id, blockedId: eve.id, createdAt: ago(10) });
  const get = async (as?: Player) => {
    const headers: Record<string, string> = as ? { authorization: `Bearer ${tokens[as.id]}` } : {};
    const res = await app.request('/api/v1/me/activity', { headers });
    return { res, body: (await res.json()) as Json };
  };
  return { store, get };
}

test('ways and hearts by others on your signs, newest first, with who and the math', async () => {
  const { store, get } = await setup();
  const w = (signId: string, wayId: string, by: Player, createdAt: string, text = '19 − 12 = 7') =>
    store.putWay(way(signId, { id: wayId, playerId: by.id, text, value: '7', createdAt }));
  await w(id(1), 'w-ben', ben, ago(1));
  await w(id(1), 'w-ada', ada, ago(0, 30)); // Ada's own
  await w(id(1), 'w-eve', eve, ago(0, 20)); // blocked
  await w(id(1), 'w-old', ben, ago(31)); // too old
  await w(id(2), 'w-cy-held', cy, ago(2), '12 − 7 + 2 = 7');
  await w(id(3), 'w-dee', dee, ago(3));
  await w(id(4), 'w-not-mine', dee, ago(0, 10));
  await w(id(5), 'w-bens-held', dee, ago(4));
  const h = (by: Player, signId: string, createdAt: string) =>
    store.putHeart({ playerId: by.id, signId, uid: `${by.handle}-${signId}`, createdAt });
  await h(cy, id(1), ago(0, 5));
  await h(fay, id(3), ago(5));
  await h(ada, id(3), ago(0, 1)); // Ada's own
  await h(eve, id(1), ago(0, 2)); // blocked
  await h(dee, id(4), ago(0, 3)); // not Ada's
  await h(ben, id(1), ago(40)); // too old

  const { res, body } = await get(ada);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(body.days, 30);
  assert.deepEqual(
    body.items.map((i: Json) => `${i.kind} ${i.sign.slug} ${i.player.name}`),
    [
      'heart exit-seven Cy',
      'way exit-seven Ben',
      'way held-up Cy',
      'way ben-found Dee',
      'way bens-held Dee',
      'heart ben-found null'
    ]
  );
  const [heart, wayItem, held, , bensHeld, nameless] = body.items;
  assert.deepEqual(heart, {
    kind: 'heart',
    at: heart.at,
    sign: {
      id: id(1),
      slug: 'exit-seven',
      title: 'Exit Seven',
      photo_thumb_url: `https://example.test/p/ph-${id(1)}/thumb.jpg`
    },
    player: {
      handle: 'cy',
      name: 'Cy',
      avatar_color: '#F2B300',
      avatar_thumb_url: 'https://example.test/p/avatar-cy/thumb.jpg'
    },
    way: null
  });
  assert.match(heart.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(wayItem.way, { id: 'w-ben', text: '19 − 12 = 7', tex: '19 - 12 = 7' });
  assert.deepEqual(wayItem.player, { handle: 'ben', name: 'Ben', avatar_color: '#004C80', avatar_thumb_url: null });
  // Ada's held sign's photo comes with her token; Ben's held sign's isn't hers to fetch.
  assert.equal(held.sign.photo_thumb_url, `https://example.test/api/v1/me/photos/ph-${id(2)}/thumb`);
  assert.equal(held.way.tex, '12 - 7 + 2 = 7');
  assert.equal(bensHeld.sign.photo_thumb_url, null);
  assert.deepEqual(nameless.player, { handle: null, name: null, avatar_color: '#006348', avatar_thumb_url: null });
});

test('a sign posted by a player you blocked drops out, though it names you a finder', async () => {
  const { store, get } = await setup();
  await addSign(
    store,
    sign({
      id: id(6),
      title: 'Eves Sign',
      postedBy: eve.id,
      finders: [
        { playerId: eve.id, name: eve.name, role: 'found' },
        { playerId: ada.id, name: ada.name, role: 'spotted' }
      ]
    })
  );
  await store.putWay(way(id(6), { id: 'w-dee-eves', playerId: dee.id, createdAt: ago(0, 5) }));
  await store.putHeart({ playerId: cy.id, signId: id(6), uid: 'cy-6', createdAt: ago(0, 6) });
  await store.putWay(way(id(1), { id: 'w-ben', playerId: ben.id, createdAt: ago(1) }));
  assert.deepEqual(
    (await get(ada)).body.items.map((i: Json) => `${i.kind} ${i.sign.slug}`),
    ['way exit-seven']
  );
  // Unblocked, it is hers again.
  await store.deleteBlock(ada.id, eve.id);
  assert.deepEqual(
    (await get(ada)).body.items.map((i: Json) => `${i.kind} ${i.sign.slug}`),
    ['way eves-sign', 'heart eves-sign', 'way exit-seven']
  );
});

test('another player sees their own signs’ activity, not yours', async () => {
  const { store, get } = await setup();
  await store.putWay(way(id(1), { id: 'w-ben', playerId: ben.id, createdAt: ago(1) }));
  await store.putWay(way(id(3), { id: 'w-dee', playerId: dee.id, createdAt: ago(1) }));
  await store.putHeart({ playerId: ada.id, signId: id(4), uid: 'ada-4', createdAt: ago(2) });
  const { body } = await get(ben);
  // Ben's Found is Ben's and Ada's both; Ben's own way on Exit Seven isn't on his list.
  assert.deepEqual(
    body.items.map((i: Json) => `${i.kind} ${i.sign.slug} ${i.player.handle}`),
    ['way ben-found dee', 'heart bens-own ada']
  );
  assert.deepEqual((await get(dee)).body, { days: 30, items: [] });
});

test(`at most ${LIMITS.activityMax} items, the newest`, async () => {
  const { store, get } = await setup();
  for (let i = 0; i < LIMITS.activityMax + 5; i++) {
    await store.putWay(way(id(1), { id: `w${String(i).padStart(3, '0')}`, playerId: ben.id, createdAt: ago(0, i) }));
  }
  const { body } = await get(ada);
  assert.equal(body.items.length, LIMITS.activityMax);
  assert.equal(body.items[0].way.id, 'w000');
  assert.equal(body.items.at(-1).way.id, `w0${LIMITS.activityMax - 1}`);
});

test('signed out is a 401', async () => {
  const { get } = await setup();
  const { res, body } = await get();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'unauthorized');
});
