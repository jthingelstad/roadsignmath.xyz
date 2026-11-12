// The day's ceiling on moderator calls across all players (`LIMITS.moderatorCallsADay`): under it
// posts, reports and profile photos go to the moderator as before; past it each is the 503 an
// unavailable moderator gives, changing nothing and logging `moderator` `ceiling`. A new UTC day
// starts at zero, the per-player limits still apply, and a counter that fails never blocks a post.
// Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MODERATOR_CALLS } from '../src/posting/posting.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const DAY = 86400;
const S1 = '01JS0000000000000000000001';

/** A store whose moderator count can't be written, as when the table is throttled. */
class CountlessStore extends MemoryStore {
  override async bump(key: string, seconds: number, now: number): Promise<number> {
    if (key === MODERATOR_CALLS) throw new Error('Throttled: the secret table name');
    return super.bump(key, seconds, now);
  }
}

const photo = (color = '#f2b300') =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

async function setup(store: MemoryStore = new MemoryStore()) {
  const photos = new MemoryPhotoStore();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos,
    moderator,
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
  await store.putSign(sign({ id: S1, title: 'Seven Twelve' }));
  await store.putWay(way(S1));
  const call = async (method: string, path: string, as: string, body?: unknown, raw?: Buffer) => {
    const headers: Record<string, string> = { authorization: `Bearer ${tokens[as]}` };
    if (raw) headers['content-type'] = 'image/jpeg';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers,
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { res, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as Json };
  };
  const upload = async (as = 'ada') => {
    const { res, body } = await call('POST', '/photos', as, undefined, await photo());
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.id as string;
  };
  const post = async (photoId: string, as = 'ada') =>
    call('POST', '/signs', as, {
      photo_ids: [photoId],
      title: 'Exit 7',
      numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
      place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
      found_on: '2026-06-01',
      way: '7 + 12 = 19'
    });
  /** Spends the day's calls (at `now`) up to `left` short of the ceiling. */
  const spend = async (left: number, now = nowSeconds()) => {
    for (let i = 0; i < LIMITS.moderatorCallsADay - left; i++) await store.bump(MODERATOR_CALLS, DAY, now);
  };
  return { store, photos, moderator, call, upload, post, spend };
}

/** Runs `work` with what it logs to the console caught. */
async function catching(work: () => Promise<void>) {
  const logged: unknown[] = [];
  const { info, error } = console;
  console.info = (...a: unknown[]) => void logged.push(a[0]);
  console.error = (...a: unknown[]) => void logged.push(a[0]);
  try {
    await work();
  } finally {
    Object.assign(console, { info, error });
  }
  return logged.filter((e) => typeof e === 'object' && e !== null && 'event' in e);
}

test('the ceiling is 300 calls a day, the owner’s number', () => {
  assert.equal(LIMITS.moderatorCallsADay, 300);
});

test('under the ceiling a post, a report and a profile photo go to the moderator', async () => {
  const t = await setup();
  await t.spend(3);
  const posted = await t.post(await t.upload());
  assert.equal(posted.res.status, 201, JSON.stringify(posted.body));
  assert.equal((await t.call('POST', `/signs/${S1}/report`, 'ben', { reason: 'Not a real sign' })).res.status, 200);
  assert.equal((await t.call('PUT', '/me/avatar', 'ben', undefined, await photo('#004c80'))).res.status, 200);
  assert.equal(t.moderator.posts.length + t.moderator.reports.length + t.moderator.avatars.length, 3);
});

test('at the ceiling a post is a 503 that changes nothing, and the line is logged', async () => {
  const t = await setup();
  await t.spend(0);
  const photoId = await t.upload();
  const before = (await t.store.allSigns()).length;
  let posted: Awaited<ReturnType<typeof t.post>> | undefined;
  const events = await catching(async () => {
    posted = await t.post(photoId);
  });
  assert.equal(posted!.res.status, 503);
  assert.equal(posted!.body.error.code, 'unavailable', 'the code the App Store app already handles');
  assert.equal(posted!.body.error.message, 'Our moderator is busy today. Try again tomorrow.');
  assert.equal(t.moderator.posts.length, 0, 'the moderator was not asked');
  assert.equal((await t.store.allSigns()).length, before, 'no sign, held or otherwise');
  const upload = (await t.store.getUpload(ada.id, photoId))!;
  assert.ok(upload && !upload.signId, 'the upload is free for the retry');
  assert.deepEqual(events, [{ event: 'moderator', outcome: 'ceiling', op: 'post' }]);
});

test('at the ceiling a report and a profile photo are 503s that change nothing', async () => {
  const t = await setup();
  await t.spend(0);
  const events = await catching(async () => {
    const report = await t.call('POST', `/signs/${S1}/report`, 'ben', { reason: 'Not a real sign' });
    assert.equal(report.res.status, 503);
    assert.equal(report.body.error.code, 'unavailable');
    const avatar = await t.call('PUT', '/me/avatar', 'ben', undefined, await photo());
    assert.equal(avatar.res.status, 503);
    assert.equal(avatar.body.error.code, 'unavailable');
  });
  assert.equal(await t.store.getReport(S1, ben.id), undefined, 'no report kept');
  assert.equal((await t.store.getSign(S1))!.visibility, 'shown');
  assert.equal((await t.store.getPlayer(ben.id))!.avatar, undefined, 'no photo set');
  assert.equal(t.moderator.reports.length + t.moderator.avatars.length, 0);
  assert.deepEqual(events, [
    { event: 'moderator', outcome: 'ceiling', op: 'report' },
    { event: 'moderator', outcome: 'ceiling', op: 'avatar' }
  ]);
});

test('a new UTC day starts at zero', async () => {
  const t = await setup();
  await t.spend(0, nowSeconds() - DAY);
  const posted = await t.post(await t.upload());
  assert.equal(posted.res.status, 201, 'yesterday’s calls don’t count today');
  assert.equal(t.moderator.posts.length, 1);
  // The window is the UTC day: a call one second before midnight and one at midnight are two days.
  const midnight = nowSeconds() - (nowSeconds() % DAY);
  assert.equal(await t.store.bump(MODERATOR_CALLS, DAY, midnight - 1), LIMITS.moderatorCallsADay + 1);
  assert.equal(await t.store.bump(MODERATOR_CALLS, DAY, midnight + DAY), 1);
});

test('the per-player limits still apply under the ceiling, before any call is counted', async () => {
  const t = await setup();
  const now = nowSeconds();
  for (let i = 0; i < LIMITS.postsADay; i++) await t.store.bump(`posts:${ada.id}`, DAY, now);
  const posted = await t.post(await t.upload());
  assert.equal(posted.res.status, 429);
  for (let i = 0; i < LIMITS.reportsADay; i++) await t.store.bump(`reports:${ben.id}`, DAY, now);
  assert.equal((await t.call('POST', `/signs/${S1}/report`, 'ben', { reason: 'Not a real sign' })).res.status, 429);
  assert.equal(t.moderator.posts.length + t.moderator.reports.length, 0);
  assert.equal(await t.store.bump(MODERATOR_CALLS, DAY, now), 1, 'refused by its own limit, nothing counted');
});

test('a moderator count that can’t be written never blocks a post, and logs nothing secret', async () => {
  const t = await setup(new CountlessStore());
  let posted: Awaited<ReturnType<typeof t.post>> | undefined;
  const photoId = await t.upload();
  const events = await catching(async () => {
    posted = await t.post(photoId);
  });
  assert.equal(posted!.res.status, 201, JSON.stringify(posted!.body));
  assert.equal(t.moderator.posts.length, 1);
  assert.deepEqual(events, [{ event: 'moderator-count', outcome: 'Error' }]);
  assert.ok(!JSON.stringify(events).includes('secret'));
});
