import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryEdgeCache } from '../src/edge-cache.ts';
import { heartUid } from '../src/hearts.ts';
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

test('set-place --to check says where the sign would go and writes nothing', async () => {
  const { store, edgeCache, deps } = await setup();
  const before = await snapshot(store);
  const lines = await runOwner(deps, 'set-place', 'exit-seven', 'check', {
    place: { lat: -37.814, lng: 144.963, label: 'Melbourne, Victoria, Australia', state: '', approximate: true }
  });
  assert.deepEqual(lines.slice(1), [
    'Now: Testville, Minnesota [MN], 44.98, -93.27 (approximate)',
    'Would move it to: Melbourne, Victoria, Australia, -37.814, 144.963 (approximate)'
  ]);
  assert.equal(await snapshot(store), before);
  assert.equal(edgeCache.clears, 0);
});

test('set-place --to live moves the sign on the map, keeps a label or state left out, and clears the edge', async () => {
  const { store, edgeCache, deps, app } = await setup();
  const lines = await runOwner(deps, 'set-place', 'exit-seven', 'live', {
    place: { lat: 41.575, lng: -87.26, state: 'in' }
  });
  assert.deepEqual(lines.slice(-2), ['Moved.', 'Cleared the edge.']);
  assert.deepEqual((await store.getSign(S1))!.place, {
    label: 'Testville, Minnesota',
    state: 'IN',
    lat: 41.575,
    lng: -87.26,
    approximate: false
  });
  assert.equal(edgeCache.clears, 1);
  const geo = (await (await app.request('/signs.geojson')).json()) as {
    features: { properties: { slug: string }; geometry: { coordinates: number[] } }[];
  };
  const moved = geo.features.find((f) => f.properties.slug === 'exit-seven')!;
  assert.deepEqual(moved.geometry.coordinates, [-87.26, 41.575]);
});

test('set-place refuses a missing or impossible place, or a state that is not two letters, and writes nothing', async () => {
  const { store, deps } = await setup();
  const before = await snapshot(store);
  for (const place of [
    { lat: 41 },
    { lat: 91, lng: 0 },
    { lat: Number.NaN, lng: 0 },
    { lat: 41, lng: -87, state: 'Indiana' }
  ]) {
    await assert.rejects(runOwner(deps, 'set-place', 'exit-seven', 'live', { place }), OwnerRefused);
  }
  await assert.rejects(runOwner(deps, 'set-place', 'nothing', 'live', { place: { lat: 1, lng: 1 } }), OwnerRefused);
  assert.equal(await snapshot(store), before);
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

test('a removal that fails partway still clears the edge, and the error goes up', async () => {
  const { store, edgeCache, deps } = await setup();
  const failing = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'deletePlayer') return async () => Promise.reject(new Error('the table is down'));
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  await assert.rejects(runOwner({ ...deps, store: failing }, 'remove-player', 'cara', 'live'), /the table is down/);
  // Her sign went before the failure, so the pages that showed it are cleared.
  assert.equal(await store.getSign(S3), undefined);
  assert.equal(edgeCache.clears, 1);
});

test('two owner commands on one sign never hold its lease at once', async () => {
  const { store, photos, deps } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const slow = new Proxy(photos, {
    get(target, key, receiver) {
      if (key === 'hide') return async (id: string) => (await gate, target.hide(id));
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const first = runOwner({ ...deps, photos: slow }, 'hide-sign', 'exit-seven', 'live');
  await new Promise((done) => setImmediate(done));
  await assert.rejects(runOwner(deps, 'hide-sign', 'exit-seven', 'live'), OwnerRefused);
  release();
  assert.ok((await first).includes('Hidden.'));
  assert.equal((await store.getSign(S1))!.visibility, 'hidden');
});

test('remove-way --to check lists the ways or says what would go, and writes nothing', async () => {
  const { store, deps } = await setup();
  const before = await snapshot(store);
  const list = await runOwner(deps, 'remove-way', 'exit-seven', 'check');
  assert.ok(list.some((l) => l.startsWith('way-cara-on-s1  19 − 12 = 7  by Cara (@cara)')));
  assert.ok(list.some((l) => l.startsWith('way-ada-on-s1  7 + 12 = 19')));
  const one = await runOwner(deps, 'remove-way', 'exit-seven', 'check', { way: 'way-cara-on-s1' });
  assert.ok(one.some((l) => l.startsWith('Would remove it and 0 co-finds on it; the sign keeps 1 way.')));
  assert.equal(await snapshot(store), before);
  await assert.rejects(runOwner(deps, 'remove-way', 'exit-seven', 'check', { way: 'nope' }), OwnerRefused);
  await assert.rejects(runOwner(deps, 'remove-way', 'exit-seven', 'live'), OwnerRefused);
  assert.equal(await snapshot(store), before);
});

test('remove-way --to live takes the way and its co-finds off, keeps the sign in step, and clears the edge', async () => {
  const { store, deps, edgeCache } = await setup();
  const first = (await store.listWays(S1))[0];
  await store.addCoFind(
    { signId: S1, wayId: first.id, playerId: ben.id, createdAt: '2026-01-12T00:00:00.000Z', via: 'quiz' },
    first
  );
  const out = await runOwner(deps, 'remove-way', 'exit-seven', 'live', { way: first.id });
  assert.ok(out.includes('Removed.'));
  assert.ok(out.includes('Cleared the edge.'));
  assert.equal(edgeCache.clears, 1);
  const left = await store.listWays(S1);
  assert.deepEqual(
    left.map((w) => w.id),
    ['way-cara-on-s1']
  );
  assert.deepEqual(await store.listCoFinds(S1), []);
  const s1 = (await store.getSign(S1))!;
  assert.equal(s1.wayCount, 1);
  assert.deepEqual(s1.firstWay, { text: '19 − 12 = 7', value: '7', playerId: cara.id });
  assert.equal((await store.listWays(S3)).length, 1, 'other signs keep their ways');
});

test('remove-way keeps the count right when a way is added while it runs', async () => {
  const { store, deps } = await setup();
  const [first, second] = await store.listWays(S1);
  // A solve lands between remove-way reading the ways and writing the sign's count.
  const update = store.updateSign.bind(store);
  let raced = false;
  store.updateSign = async (id, changes) => {
    if (!raced) {
      raced = true;
      await store.addWay(
        way(S1, {
          id: 'way-ben-on-s1',
          playerId: ben.id,
          text: '7 × 12 = 84',
          value: '84',
          createdAt: '2026-11-12T12:00:00.000Z'
        })
      );
    }
    return update(id, changes);
  };
  await runOwner(deps, 'remove-way', 'exit-seven', 'live', { way: second.id });
  const left = await store.listWays(S1);
  assert.deepEqual(
    left.map((w) => w.id),
    [first.id, 'way-ben-on-s1']
  );
  const s1 = (await store.getSign(S1))!;
  assert.equal(s1.wayCount, 2);
  assert.equal(s1.firstWay?.text, first.text);
});

// ---------------------------------------------------------------------------------------------
// merge-signs

const S4 = '01JS0000000000000000000004';

/**
 * The setup, plus "Exit Seven Again" (exit-seven-again): the same road sign as Exit Seven posted
 * again by Ben, with two photos, the same way as Ada's in another order (Ben found it too), a new
 * way of Ben's (Cara found it too), hearts from Ben (only here) and Cara (here and on Exit Seven), a
 * website heart, a report and a duplicate report.
 */
async function mergeSetup() {
  const s = await setup();
  const { store, photos, tinylytics } = s;
  await addSign(
    store,
    sign({
      id: S4,
      title: 'Exit Seven Again',
      postedBy: ben.id,
      caption: 'Seen again on the way north. Also see the first one!',
      foundOn: '2025-06-01',
      postedAt: '2025-06-02T08:00:00.000Z',
      place: { label: 'Northtown, Minnesota', state: 'MN', lat: 45.1, lng: -93.3, approximate: false },
      finders: [
        { playerId: ben.id, name: ben.name, role: 'found' },
        { name: 'Grandpa Joe', role: 'spotted' }
      ],
      photos: [
        { id: 'ph-s4-a', width: 1600, height: 1200, alt: 'The exit sign at dusk' },
        { id: 'ph-s4-b', width: 1600, height: 1200, alt: 'Photo of the Exit Seven Again sign' }
      ],
      firstWay: { text: '12 + 7 = 19', value: '19', playerId: ben.id },
      wayCount: 2
    })
  );
  for (const id of ['ph-s4-a', 'ph-s4-b']) {
    await photos.putUpload(id, { large: Buffer.from('l'), thumb: Buffer.from('t'), width: 1600, height: 1200 });
    await photos.publish(id, 'shown');
  }
  const same = way(S4, {
    id: 'way-ben-same',
    playerId: ben.id,
    text: '12 + 7 = 19',
    createdAt: '2025-06-02T08:00:00.000Z'
  });
  const fresh = way(S4, {
    id: 'way-ben-new',
    playerId: ben.id,
    text: '19 − 7 = 12',
    value: '12',
    numbers: ['19', '7', '12'],
    createdAt: '2025-06-03T08:00:00.000Z'
  });
  await store.putWay(same);
  await store.putWay(fresh);
  await store.addCoFind(
    { signId: S4, wayId: same.id, playerId: cara.id, createdAt: '2025-06-04T00:00:00.000Z', via: 'quiz' },
    same
  );
  await store.addCoFind(
    { signId: S4, wayId: fresh.id, playerId: cara.id, createdAt: '2025-06-05T00:00:00.000Z', via: 'app' },
    fresh
  );
  for (const [player, signId, uid] of [
    [ben.id, S4, 'ben-s4'],
    [cara.id, S4, 'cara-s4'],
    [cara.id, S1, 'cara-s1']
  ] as const) {
    await store.putHeart({ playerId: player, signId, uid, createdAt: '2026-01-05T00:00:00.000Z' });
    tinylytics.kudosKept.push({ path: signId === S4 ? '/signs/exit-seven-again' : '/signs/exit-seven', uid });
  }
  tinylytics.kudosKept.push({ path: '/signs/exit-seven-again', uid: 'website-1' });
  await store.putReport({
    signId: S4,
    playerId: cara.id,
    reason: 'Posted twice',
    outcome: 'kept',
    note: 'Fine',
    createdAt: '2026-01-06T00:00:00.000Z'
  });
  await store.putDuplicate({ signId: S4, playerId: ada.id, sameAs: S1, createdAt: '2026-01-06T00:00:00.000Z' });
  return s;
}

const MERGE = {
  drop: 'exit-seven-again',
  photos: 'drop:1,keep:1',
  foundOn: 'drop',
  postedAt: 'drop',
  place: 'drop',
  caption: 'both',
  captionTrim: 'Also see the first one!'
} as const;

async function mergedState(store: MemoryStore, tinylytics: FakeTinylytics, photos: MemoryPhotoStore) {
  return JSON.stringify({
    signs: await store.allSigns(),
    ways: await store.listWays(S1),
    coFinds: await store.listCoFinds(S1),
    hearts: [await store.listHearts(ben.id), await store.listHearts(cara.id)],
    kudos: [...tinylytics.kudosKept].sort((a, b) => a.uid.localeCompare(b.uid)),
    files: await Promise.all(
      [`ph-${S1}`, 'ph-s4-a', 'ph-s4-b'].map(async (id) => !!(await photos.get(id, 'large', 'shown')))
    ),
    slug: await store.slugHolder('exit-seven-again')
  });
}

test('merge-signs --to check says what the merge would do and writes nothing', async () => {
  const { store, deps, tinylytics, edgeCache } = await mergeSetup();
  const before = await snapshot(store);
  const kudos = JSON.stringify(tinylytics.kudosKept);
  const out = await runOwner(deps, 'merge-signs', 'exit-seven', 'check', { merge: MERGE });
  const text = out.join('\n');
  assert.match(text, /^Keep: “Exit Seven” \(exit-seven\)/);
  assert.match(text, /Drop: “Exit Seven Again” \(exit-seven-again\), posted by Ben \(@ben\): shown, 2 photos/);
  assert.match(text, /Photos, in order: drop:1 ph-s4-a “The exit sign at dusk”; keep:1 ph-01JS0000000000000000000001/);
  assert.match(text, /Photos deleted: drop:2 ph-s4-b/);
  assert.match(text, /Found on: 2026-01-10 → 2025-06-01/);
  assert.match(text, /Posted at: 2026-01-10T12:00:00.000Z → 2025-06-02T08:00:00.000Z/);
  assert.match(text, /Place: Testville.* → Northtown, Minnesota/);
  assert.match(text, /Caption \(both, trimmed, \d+ characters\): "Seen again on the way north."/);
  assert.match(text, /Finders: Ada \(@ada\), Cara \(@cara\), Ben \(@ben\), Grandpa Joe/);
  assert.match(
    text,
    /Way 12 \+ 7 = 19 \(way-ben-same\) by Ben \(@ben\) is the same way as exit-seven’s 7 \+ 12 = 19 \(way-ada-on-s1\) by Ada \(@ada\): it goes, and Ben \(@ben\), Cara \(@cara\) would be credited/
  );
  assert.match(text, /Way 19 − 7 = 12 \(way-ben-new\) by Ben \(@ben\) would move to exit-seven, with 1 co-find/);
  assert.match(text, /Hearts on exit-seven-again: 2 player’s hearts \(1 would move to exit-seven, 1 on both/);
  assert.match(text, /kudos at \/signs\/exit-seven-again: 3, of them website hearts: 1, which would be taken back/);
  assert.match(text, /Reports on exit-seven-again: 1 report and 1 duplicate report/);
  assert.match(text, /\/signs\/exit-seven-again .* would lead to \/signs\/exit-seven with a 301/);
  assert.equal(await snapshot(store), before);
  assert.equal(JSON.stringify(tinylytics.kudosKept), kudos);
  assert.equal(edgeCache.clears, 0);
});

test('merge-signs --to live makes one sign, moves ways, finders, hearts and photos, and the old slug leads there', async () => {
  const { store, photos, tinylytics, edgeCache, deps, app } = await mergeSetup();
  const out = await runOwner(deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE });
  assert.ok(out.includes('Merged exit-seven-again into exit-seven.'), out.join('\n'));
  assert.equal(edgeCache.clears, 1);

  assert.equal(await store.getSign(S4), undefined);
  const kept = (await store.getSign(S1))!;
  assert.equal(kept.slug, 'exit-seven');
  assert.equal(kept.title, 'Exit Seven');
  assert.deepEqual(
    kept.photos.map((p) => [p.id, p.alt]),
    [
      ['ph-s4-a', 'The exit sign at dusk'],
      [`ph-${S1}`, 'Photo of the Exit Seven sign']
    ]
  );
  assert.equal(kept.caption, 'Seen again on the way north.');
  assert.equal(kept.foundOn, '2025-06-01');
  assert.equal(kept.postedAt, '2025-06-02T08:00:00.000Z');
  assert.equal(kept.place.label, 'Northtown, Minnesota');
  assert.deepEqual(
    kept.finders.map((f) => f.playerId ?? f.name),
    [ada.id, cara.id, ben.id, 'Grandpa Joe']
  );
  assert.deepEqual(kept.merged, [
    { signId: S4, slug: 'exit-seven-again', at: '2026-11-10T18:00:00.000Z', photosRemoved: ['ph-s4-b'] }
  ]);

  // Ways: the same way stays Ada's with Ben and Cara credited; Ben's new way moved with its co-find.
  const ways = await store.listWays(S1);
  assert.deepEqual(
    ways.map((w) => [w.id, w.signId]),
    [
      ['way-ben-new', S1],
      ['way-ada-on-s1', S1],
      ['way-cara-on-s1', S1]
    ]
  );
  // Ways keep when they were found, so a moved way older than the kept sign's comes first.
  assert.equal(kept.wayCount, 3);
  assert.equal(kept.firstWay?.text, '19 − 7 = 12');
  const coFinds = (await store.listCoFinds(S1)).map((c) => [c.wayId, c.playerId]).sort();
  assert.deepEqual(coFinds, [
    ['way-ada-on-s1', ben.id],
    ['way-ada-on-s1', cara.id],
    ['way-ben-new', cara.id]
  ]);
  assert.deepEqual(await store.listWays(S4), []);
  assert.deepEqual(await store.listCoFinds(S4), []);

  // Hearts: Ben's moved under the heart code's uid; Cara keeps her one on Exit Seven; the website's went.
  assert.deepEqual(
    (await store.listHearts(ben.id)).map((h) => [h.signId, h.uid]),
    [[S1, heartUid(ben.id, S1)]]
  );
  assert.deepEqual((await store.listHearts(cara.id)).map((h) => h.signId).sort(), [S1, S2].sort());
  assert.deepEqual(
    tinylytics.kudosKept
      .filter((k) => k.path.startsWith('/signs/exit-seven'))
      .map((k) => [k.path, k.uid])
      .sort(),
    [
      ['/signs/exit-seven', 'cara-s1'],
      ['/signs/exit-seven', heartUid(ben.id, S1)]
    ].sort()
  );

  // Reports go with the dropped sign; the dropped photo left out is deleted, the moved one stays.
  assert.equal(await store.getReport(S4, cara.id), undefined);
  assert.equal(await store.getDuplicate(S4, ada.id), undefined);
  assert.ok(await photos.get('ph-s4-a', 'large', 'shown'));
  assert.ok(await photos.get(`ph-${S1}`, 'large', 'shown'));
  assert.equal(await photos.get('ph-s4-b', 'large', 'shown'), undefined);

  // The old slug leads to the kept sign, on the site, in the API and in Quiz.
  const site = await app.request('/signs/exit-seven-again?view=map');
  assert.equal(site.status, 301);
  assert.equal(site.headers.get('location'), '/signs/exit-seven?view=map');
  const api = await app.request('/api/v1/signs/exit-seven-again');
  assert.equal(api.status, 301);
  assert.equal(api.headers.get('location'), '/api/v1/signs/exit-seven');
  assert.ok(api.headers.get('API-Version'));
  const quizApp = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos,
    moderator: new ScriptedModerator(),
    quizOpen: true
  });
  const quiz = await quizApp.request('/signs/exit-seven-again/ways', { headers: { 'X-RSM-Front': 'quiz' } });
  assert.equal(quiz.status, 301);
  assert.equal(quiz.headers.get('location'), '/signs/exit-seven/ways');
  assert.equal(quiz.headers.get('cache-control'), 'no-store');

  // The kept sign answers, without the private merge record; lists name it once.
  const detail = await app.request('/api/v1/signs/exit-seven');
  assert.equal(detail.status, 200);
  assert.ok(!(await detail.text()).includes('merged'));
  const data = (await (await app.request('/signs.json')).json()) as { signs: { slug: string }[] };
  assert.deepEqual(
    data.signs.map((s) => s.slug).filter((s) => s.startsWith('exit-seven')),
    ['exit-seven']
  );
  const feed = (await (await app.request('/feed.json')).json()) as { items: { id: string }[] };
  assert.equal(feed.items.filter((i) => i.id.includes('/signs/exit-seven')).length, 1);
  assert.ok(feed.items.some((i) => i.id.endsWith('/signs/exit-seven')));
  const sitemap = await (await app.request('/sitemap.xml')).text();
  assert.ok(!sitemap.includes('exit-seven-again'));
  assert.equal(sitemap.split('/signs/exit-seven<').length - 1, 1);

  // Done: a check says there is nothing to do.
  const again = await runOwner(deps, 'merge-signs', 'exit-seven', 'check', { merge: MERGE });
  assert.match(again.at(-1)!, /exit-seven-again was merged into exit-seven already: nothing to do/);
});

test('a merge that fails partway finishes on a re-run, as one run would have', async () => {
  const clean = await mergeSetup();
  await runOwner(clean.deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE });
  const expected = await mergedState(clean.store, clean.tinylytics, clean.photos);

  const { store, tinylytics, photos, deps, edgeCache } = await mergeSetup();
  // The slug's move fails after the fields, ways and hearts are written.
  const moveSlug = store.moveSlug.bind(store);
  store.moveSlug = async () => {
    throw new Error('DynamoDB went away');
  };
  await assert.rejects(runOwner(deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE }), /went away/);
  assert.equal(edgeCache.clears, 1, 'a failed merge still clears the edge');
  assert.ok(await store.getSign(S4), 'the dropped sign is still there');
  assert.ok((await store.getSign(S1))!.merged);

  store.moveSlug = moveSlug;
  const check = await runOwner(deps, 'merge-signs', 'exit-seven', 'check', { merge: MERGE });
  assert.ok(check.some((l) => /A merge started .* already wrote exit-seven’s photos/.test(l)));
  const out = await runOwner(deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE });
  assert.ok(out.includes('Merged exit-seven-again into exit-seven.'), out.join('\n'));
  assert.equal(await mergedState(store, tinylytics, photos), expected);
});

test('a merge whose heart move fails changes neither sign, and a re-run finishes it', async () => {
  const { store, tinylytics, deps } = await mergeSetup();
  tinylytics.failing.add('removeKudo');
  await assert.rejects(runOwner(deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE }));
  assert.equal((await store.getSign(S1))!.merged, undefined);
  assert.ok(await store.getSign(S4));
  tinylytics.failing.clear();
  const out = await runOwner(deps, 'merge-signs', 'exit-seven', 'live', { merge: MERGE });
  assert.ok(out.includes('Merged exit-seven-again into exit-seven.'));
  assert.deepEqual(
    (await store.listHearts(ben.id)).map((h) => h.signId),
    [S1]
  );
  assert.ok(!tinylytics.kudosKept.some((k) => k.path === '/signs/exit-seven-again'));
});

test('merge-signs keeps both signs’ photos by default and refuses what it can’t do, writing nothing', async () => {
  const { store, deps } = await mergeSetup();
  const out = await runOwner(deps, 'merge-signs', 'exit-seven', 'check', { merge: { drop: 'exit-seven-again' } });
  assert.ok(out.some((l) => l.startsWith(`Photos, in order: keep:1 ph-${S1}`) && l.includes('drop:2 ph-s4-b')));
  assert.ok(out.includes('Photos deleted: none'));
  assert.ok(out.includes('Caption: no change.'));

  const refused = async (
    merge: NonNullable<Parameters<typeof runOwner>[4]>['merge'],
    message: RegExp,
    keep = 'exit-seven'
  ) =>
    assert.rejects(runOwner(deps, 'merge-signs', keep, 'live', { merge }), (err: Error) => {
      assert.ok(err instanceof OwnerRefused, err.message);
      assert.match(err.message, message);
      return true;
    });
  await refused({ drop: 'exit-seven' }, /into itself/);
  await refused({ drop: 'nowhere' }, /No sign with the slug nowhere/);
  await refused({ drop: 'exit-seven-again', photos: 'drop:3' }, /has 2 photos/);
  await refused({ drop: 'exit-seven-again', photos: 'drop:1,drop:1' }, /twice/);
  await refused({ drop: 'exit-seven-again', photos: 'left:1' }, /isn’t one/);
  await refused({ drop: 'exit-seven-again', caption: 'keep', captionTrim: 'Not there.' }, /doesn’t end with/);
  // Five photos in all is one too many with no --photos.
  await store.updateSign(S4, {
    photos: ['a', 'b', 'c', 'd'].map((x) => ({ id: `ph-s4-${x}`, width: 1, height: 1, alt: 'x' }))
  });
  await refused({ drop: 'exit-seven-again' }, /at most 4 photos/);
  await store.updateSign(S4, { photos: [{ id: 'ph-s4-a', width: 1600, height: 1200, alt: 'The exit sign at dusk' }] });
  // A way that uses a number the kept sign doesn't show can't move.
  const odd = way(S4, {
    id: 'way-odd',
    text: '7 + 5 = 12',
    value: '12',
    numbers: ['7', '5', '12'],
    createdAt: '2025-07-01T00:00:00.000Z'
  });
  await store.putWay(odd);
  await refused({ drop: 'exit-seven-again' }, /uses 5, which exit-seven doesn’t show/);
  await store.deleteWay(odd);
  // Hearts to move and no Tinylytics key: refused before any write.
  const noKey: OwnerDeps = { ...deps, tinylytics: undefined };
  await assert.rejects(
    runOwner({ ...noKey, kudoCount: async () => 3 }, 'merge-signs', 'exit-seven', 'live', { merge: MERGE }),
    /No Tinylytics key/
  );
  assert.equal((await store.getSign(S1))!.merged, undefined);
  assert.ok(await store.getSign(S4));
});

test('merge-signs needs no Tinylytics key when the dropped sign has no hearts', async () => {
  const { store, deps, tinylytics } = await mergeSetup();
  for (const p of [ben.id, cara.id]) await store.deleteHeart(p, S4);
  tinylytics.kudosKept = tinylytics.kudosKept.filter((k) => k.path !== '/signs/exit-seven-again');
  const noKey: OwnerDeps = { ...deps, tinylytics: undefined };
  const check = await runOwner({ ...noKey, kudoCount: async () => 0 }, 'merge-signs', 'exit-seven', 'check', {
    merge: MERGE
  });
  assert.ok(check.includes('Tinylytics: nothing to change, so no key is needed.'));
  const out = await runOwner({ ...noKey, kudoCount: async () => 0 }, 'merge-signs', 'exit-seven', 'live', {
    merge: MERGE
  });
  assert.ok(out.includes('Merged exit-seven-again into exit-seven.'));
});

// ---------------------------------------------------------------------------------------------
// set-alt

test('set-alt --to check shows each change, skips alt text someone wrote, and writes nothing', async () => {
  const { store, deps, edgeCache } = await setup();
  await store.updateSign(S2, { photos: [{ id: `ph-${S2}`, width: 1600, height: 1200, alt: 'A green mile marker' }] });
  const before = await snapshot(store);
  const alts = [
    { sign_id: S1, photo_id: `ph-${S1}`, alt: 'A blue exit sign reading 7, beside a 12 and a 19', extra: 'ignored' },
    { sign_id: S2, photo_id: `ph-${S2}`, alt: 'Mile marker 12' }
  ];
  const out = await runOwner(deps, 'set-alt', '', 'check', { alts });
  assert.deepEqual(out, [
    `exit-seven ph-${S1}: “Photo of the Exit Seven sign” → “A blue exit sign reading 7, beside a 12 and a 19”`,
    `mile-twelve ph-${S2}: skipped, it already has its own alt text (--force replaces it): “A green mile marker” (not “Mile marker 12”)`,
    'Would write 1 alt text on 1 sign.'
  ]);
  assert.equal(await snapshot(store), before);
  assert.equal(edgeCache.clears, 0);
});

test('set-alt --to live writes only the alt text, --force replaces written alt text, and the edge clears once', async () => {
  const { store, deps, edgeCache } = await setup();
  await store.updateSign(S2, { photos: [{ id: `ph-${S2}`, width: 1600, height: 1200, alt: 'A green mile marker' }] });
  const alts = [
    { sign_id: S1, photo_id: `ph-${S1}`, alt: 'A blue exit sign' },
    { sign_id: S2, photo_id: `ph-${S2}`, alt: 'Mile marker 12' },
    { sign_id: S3, photo_id: `ph-${S3}`, alt: 'Photo of the Route Nine sign' }
  ];
  const out = await runOwner(deps, 'set-alt', '', 'live', { alts });
  assert.ok(out.includes('Written.'));
  assert.equal(edgeCache.clears, 1);
  assert.equal((await store.getSign(S1))!.photos[0].alt, 'A blue exit sign');
  assert.equal((await store.getSign(S2))!.photos[0].alt, 'A green mile marker');
  assert.equal((await store.getSign(S1))!.wayCount, 2, 'nothing else on the sign changes');
  assert.ok(out.includes(`route-nine ph-${S3}: unchanged “Photo of the Route Nine sign”`));

  await runOwner(deps, 'set-alt', '', 'live', { alts, force: true });
  assert.equal((await store.getSign(S2))!.photos[0].alt, 'Mile marker 12');
  assert.equal(edgeCache.clears, 2);
  const none = await runOwner(deps, 'set-alt', '', 'live', { alts, force: true });
  assert.equal(none.at(-1), 'Writing 0 alt texts on 0 signs.');
  assert.equal(edgeCache.clears, 2, 'nothing to write clears nothing');
});

test('set-alt refuses the whole file, naming each bad entry, and writes nothing', async () => {
  const { store, deps } = await setup();
  const before = await snapshot(store);
  const alts = [
    { sign_id: S1, photo_id: `ph-${S1}`, alt: 'Good alt text' },
    { sign_id: 'nope', photo_id: 'x', alt: 'Fine' },
    { sign_id: S2, photo_id: 'not-a-photo', alt: 'Fine' },
    { sign_id: S3, photo_id: `ph-${S3}`, alt: '  ' },
    { sign_id: S3, photo_id: `ph-${S3}`, alt: 'x'.repeat(301) },
    { sign_id: S2, photo_id: `ph-${S2}`, alt: 'Two\nlines' }
  ];
  await assert.rejects(runOwner(deps, 'set-alt', '', 'live', { alts }), (err: Error) => {
    assert.ok(err instanceof OwnerRefused);
    assert.match(err.message, /#2 \(nope \/ x\): no such sign/);
    assert.match(err.message, /#3 .*: mile-twelve has no such photo/);
    assert.match(err.message, /#4 .*: the alt text is empty/);
    assert.match(err.message, /#5 .*: the alt text is 301 characters, over 300/);
    assert.match(err.message, /#5 .*: that photo is in the file twice/);
    assert.match(err.message, /#6 .*: the alt text has a line break/);
    assert.doesNotMatch(err.message, /#1 /);
    return true;
  });
  await assert.rejects(runOwner(deps, 'set-alt', '', 'check', { alts: { not: 'a list' } }), OwnerRefused);
  assert.equal(await snapshot(store), before);
});
