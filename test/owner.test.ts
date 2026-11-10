import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryEdgeCache } from '../src/edge-cache.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryNewsletter } from '../src/newsletter.ts';
import { OWNER_HIDE_NOTE, OwnerRefused, runOwner, type OwnerDeps } from '../src/owner.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { FakeTinylytics } from './support/tinylytics.ts';

const S1 = '01JS0000000000000000000001';
const S2 = '01JS0000000000000000000002';
const S3 = '01JS0000000000000000000003';

const cara: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cara',
  name: 'Cara',
  avatarColor: '#004C80',
  email: 'cara@example.com',
  createdAt: '2026-01-03T00:00:00.000Z'
};

async function setup() {
  const store = new MemoryStore();
  const photos = new MemoryPhotoStore();
  const tinylytics = new FakeTinylytics();
  const newsletter = new MemoryNewsletter();
  const edgeCache = new MemoryEdgeCache();
  for (const p of [ada, ben, cara]) await addPlayer(store, p);
  await addSign(store, sign({ id: S1, title: 'Exit Seven' }));
  await addSign(store, sign({ id: S2, title: 'Mile Twelve' }));
  // Cara's sign, with a way by Ada; Cara found a way on Ada's sign and is among its finders.
  await addSign(
    store,
    sign({
      id: S3,
      title: 'Route Nine',
      postedBy: cara.id,
      finders: [{ playerId: cara.id, name: cara.name, role: 'found' }]
    })
  );
  await store.putWay(way(S3, { id: 'way-ada-on-s3' }));
  await store.putWay(way(S1, { id: 'way-ada-on-s1' }));
  await store.putWay(
    way(S1, {
      id: 'way-cara-on-s1',
      createdAt: '2026-01-11T12:00:00.000Z',
      playerId: cara.id,
      text: '19 − 12 = 7',
      value: '7'
    })
  );
  await store.updateSign(S1, {
    wayCount: 2,
    finders: [
      { playerId: ada.id, name: ada.name, role: 'found' },
      { playerId: cara.id, name: cara.name, role: 'spotted' }
    ]
  });
  for (const id of [S1, S2, S3]) {
    const s = (await store.getSign(id))!;
    for (const photo of s.photos)
      await photos.putUpload(photo.id, { large: Buffer.from('l'), thumb: Buffer.from('t'), width: 1600, height: 1200 });
    for (const photo of s.photos) await photos.publish(photo.id, 'shown');
  }
  await store.putHeart({ playerId: cara.id, signId: S2, uid: 'cara-s2', createdAt: '2026-01-04T00:00:00.000Z' });
  tinylytics.kudosKept.push({ path: '/signs/mile-twelve', uid: 'cara-s2' });
  newsletter.list.add('cara@example.com');
  const deps: OwnerDeps = {
    store,
    photos,
    tinylytics,
    newsletter,
    edgeCache,
    now: () => new Date('2026-11-10T18:00:00Z')
  };
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos,
    moderator: new ScriptedModerator()
  });
  return { store, photos, tinylytics, newsletter, edgeCache, deps, app };
}

/** Everything the store holds, to show a check wrote nothing. */
async function snapshot(store: MemoryStore) {
  const signs = await store.allSigns();
  const ways = await Promise.all(signs.map((s) => store.listWays(s.id)));
  return JSON.stringify({ signs, ways, players: await store.allPlayers(), hearts: await store.listHearts(cara.id) });
}

test('hide-sign --to check says what would change and writes nothing', async () => {
  const { store, photos, edgeCache, deps } = await setup();
  const before = await snapshot(store);
  const lines = await runOwner(deps, 'hide-sign', 'exit-seven', 'check');
  assert.deepEqual(lines, [
    '“Exit Seven” (exit-seven), posted by Ada (@ada): shown, 1 photo, 2 ways',
    `Would hide it: its photos and page leave the site, the feeds and the API, and its poster sees “${OWNER_HIDE_NOTE}”.`
  ]);
  assert.equal(await snapshot(store), before);
  assert.ok(await photos.get(`ph-${S1}`, 'large', 'shown'));
  assert.equal(edgeCache.clears, 0);
});

test('hide-sign --to live hides it as an upheld report does, and clears the edge; unhide-sign shows it again', async () => {
  const { store, photos, edgeCache, deps, app } = await setup();
  const lines = await runOwner(deps, 'hide-sign', 'exit-seven', 'live', { note: 'Not a road sign.' });
  assert.deepEqual(lines.slice(-2), ['Hidden.', 'Cleared the edge.']);
  const hidden = (await store.getSign(S1))!;
  assert.equal(hidden.visibility, 'hidden');
  assert.deepEqual(hidden.moderation, { note: 'Not a road sign.', at: '2026-11-10T18:00:00.000Z' });
  assert.equal(await photos.get(`ph-${S1}`, 'large', 'shown'), undefined);
  assert.ok(await photos.get(`ph-${S1}`, 'large', 'held'));
  assert.equal(edgeCache.clears, 1);
  // Gone from the site, the feeds and the API.
  assert.equal((await app.request('/signs/exit-seven')).status, 404);
  assert.ok(!(await (await app.request('/feed.json')).text()).includes('exit-seven'));
  assert.equal((await app.request('/api/v1/signs/exit-seven')).status, 404);
  assert.deepEqual(await runOwner(deps, 'hide-sign', 'exit-seven', 'live'), [
    '“Exit Seven” (exit-seven), posted by Ada (@ada): hidden, 1 photo, 2 ways',
    'Already hidden: nothing to do.'
  ]);

  assert.deepEqual(await runOwner(deps, 'unhide-sign', 'exit-seven', 'check'), [
    '“Exit Seven” (exit-seven), posted by Ada (@ada): hidden, 1 photo, 2 ways',
    'Would show it again: its photos and page are back on the site, the feeds and the API.'
  ]);
  assert.equal((await store.getSign(S1))!.visibility, 'hidden');
  const shown = await runOwner(deps, 'unhide-sign', 'exit-seven', 'live');
  assert.deepEqual(shown.slice(-2), ['Shown.', 'Cleared the edge.']);
  const back = (await store.getSign(S1))!;
  assert.equal(back.visibility, 'shown');
  assert.equal(back.moderation, undefined);
  assert.ok(await photos.get(`ph-${S1}`, 'large', 'shown'));
  assert.equal((await app.request('/signs/exit-seven')).status, 200);
  assert.equal(edgeCache.clears, 2);
});

test('a hide waits for a report being looked at, and an unknown sign or player is refused', async () => {
  const { store, deps } = await setup();
  assert.ok(await store.lease(`report:${S1}`, 'someone', 120));
  await assert.rejects(runOwner(deps, 'hide-sign', 'exit-seven', 'live'), OwnerRefused);
  assert.equal((await store.getSign(S1))!.visibility, 'shown');
  await assert.rejects(runOwner(deps, 'hide-sign', 'nowhere', 'check'), /No sign with the slug nowhere/);
  await assert.rejects(runOwner(deps, 'remove-player', 'nobody', 'check'), /No player @nobody/);
});

test('remove-player --to check counts what would go, never prints the address, and writes nothing', async () => {
  const { store, tinylytics, newsletter, edgeCache, deps } = await setup();
  const before = await snapshot(store);
  const lines = await runOwner(deps, 'remove-player', '@cara', 'check');
  assert.deepEqual(lines, [
    'Cara (@cara), playing since 2026-01-03',
    'Would remove: the account, 1 sign they posted (with their photos, ways and hearts), 1 way on other signs, their place among the finders of 1 other sign, 1 heart, no profile photo, their reports and blocks, and their email address.',
    'Their address would leave the newsletter.',
    'Their signs: route-nine'
  ]);
  assert.ok(!lines.join('\n').includes('cara@example.com'));
  assert.equal(await snapshot(store), before);
  assert.equal(tinylytics.kudosKept.length, 1);
  assert.ok(newsletter.list.has('cara@example.com'));
  assert.equal(edgeCache.clears, 0);
});

test('remove-player --to live does what DELETE /me does, newsletter included, and clears the edge', async () => {
  const { store, photos, tinylytics, newsletter, edgeCache, deps } = await setup();
  const lines = await runOwner(deps, 'remove-player', 'cara', 'live');
  assert.deepEqual(lines.slice(-2), ['Removed @cara. Newsletter: removed.', 'Cleared the edge.']);
  assert.ok(!lines.join('\n').includes('cara@example.com'));
  assert.equal(await store.getPlayer(cara.id), undefined);
  assert.equal(await store.playerIdForEmail('cara@example.com'), undefined);
  assert.equal(await store.getSign(S3), undefined);
  assert.equal(await photos.get(`ph-${S3}`, 'large', 'shown'), undefined);
  const s1 = (await store.getSign(S1))!;
  assert.deepEqual(
    s1.finders.map((f) => f.playerId),
    [ada.id]
  );
  assert.equal(s1.wayCount, 1);
  assert.deepEqual(await store.listHearts(cara.id), []);
  assert.equal(tinylytics.kudosKept.length, 0);
  assert.ok(!newsletter.list.has('cara@example.com'));
  assert.equal(edgeCache.clears, 1);
});

test('remove-player --to live refuses without the Tinylytics or newsletter key, and removes nothing', async () => {
  const { store, deps } = await setup();
  await assert.rejects(runOwner({ ...deps, tinylytics: undefined }, 'remove-player', 'cara', 'live'), /Tinylytics/);
  await assert.rejects(runOwner({ ...deps, newsletter: undefined }, 'remove-player', 'cara', 'live'), /newsletter/);
  assert.ok(await store.getPlayer(cara.id));
});
