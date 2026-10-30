import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const cy: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cy',
  name: 'Cy',
  avatarColor: '#B01C33',
  createdAt: '2026-01-03T00:00:00.000Z'
};

const photo = (color = '#f2b300') =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'a camera' } })
    .toBuffer();

async function setup() {
  const store = new MemoryStore();
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
  for (const player of [ada, ben, cy]) {
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
  const call = async (
    method: string,
    path: string,
    options: { as?: string; body?: unknown; raw?: Buffer; type?: string; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.as) headers.authorization = `Bearer ${tokens[options.as]}`;
    let body: Uint8Array | string | undefined;
    if (options.raw) {
      headers['content-type'] = options.type ?? 'image/jpeg';
      body = new Uint8Array(options.raw);
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const res = await app.request(`/api/v1${path}`, { method, headers, body });
    const bytes = Buffer.from(await res.arrayBuffer());
    const json = res.headers.get('content-type')?.includes('json') && bytes.length > 0;
    return { res, body: (json ? JSON.parse(bytes.toString()) : null) as Json, bytes };
  };
  const upload = async (as = 'ada') => {
    const { res, body } = await call('POST', '/photos', { as, raw: await photo() });
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.id as string;
  };
  const post = async (overrides: Json = {}, as = 'ada', headers?: Record<string, string>) =>
    call('POST', '/signs', {
      as,
      headers,
      body: {
        photo_ids: [await upload(as)],
        title: 'Exit 7',
        numbers: [{ value: '7', text: 'EXIT 7' }, { value: '12' }, { value: '19', box: [0.1, 0.2, 0.3, 0.1] }],
        place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
        found_on: '2026-06-01',
        way: '7 + 12 = 19',
        ...overrides
      }
    });
  return { store, photos, moderator, call, upload, post };
}

test('an upload is kept at both sizes without its metadata, for a day', async () => {
  const t = await setup();
  const { res, body } = await t.call('POST', '/photos', { as: 'ada', raw: await photo() });
  assert.equal(res.status, 201);
  assert.match(body.id, /^[0-9a-z]{26}$/);
  assert.deepEqual([body.width, body.height], [64, 48]);
  const large = (await t.photos.get(body.id, 'large', 'upload'))!;
  assert.ok(await t.photos.get(body.id, 'thumb', 'upload'));
  assert.equal((await sharp(large).metadata()).exif, undefined);
  const upload = (await t.store.getUpload(ada.id, body.id))!;
  assert.ok(upload.expiresAt - nowSeconds() <= LIMITS.uploadTtl);
});

test('an upload must be a photo of a kind we take, and not too big', async () => {
  const t = await setup();
  assert.equal((await t.call('POST', '/photos', { raw: await photo() })).res.status, 401);
  const gif = await t.call('POST', '/photos', { as: 'ada', raw: await photo(), type: 'image/gif' });
  assert.equal(gif.res.status, 400);
  const junk = await t.call('POST', '/photos', { as: 'ada', raw: Buffer.from('not a photo') });
  assert.equal(junk.res.status, 400);
  assert.match(junk.body.error.message, /couldn’t be read/);
  const big = await t.call('POST', '/photos', { as: 'ada', raw: Buffer.alloc(LIMITS.photoBytes + 1) });
  assert.equal(big.res.status, 413);
  assert.equal(big.body.error.code, 'too_large');
});

test('a post goes past the moderator, publishes its photos and uses the alt text it wrote', async () => {
  const t = await setup();
  t.moderator.post = { verdict: 'ok', reason: '', alt: ['A green exit sign for Exit 7.'] };
  const { res, body } = await t.post({ caption: 'Seen on the way north.' });
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.slug, 'exit-7');
  assert.equal(body.visibility, 'shown');
  assert.equal(body.moderation_note, null);
  assert.equal(body.photos[0].alt, 'A green exit sign for Exit 7.');
  assert.deepEqual(body.finders, [{ name: 'Ada', handle: 'ada', role: 'found' }]);
  assert.deepEqual(body.first_way, { text: '7 + 12 = 19', value: '19' });
  assert.equal(body.ways.length, 1);
  assert.equal(body.ways[0].by.handle, 'ada');
  assert.deepEqual(body.numbers[2].box, [0.1, 0.2, 0.3, 0.1]);

  const seen = t.moderator.posts[0];
  assert.equal(seen.title, 'Exit 7');
  assert.equal(seen.caption, 'Seen on the way north.');
  assert.deepEqual(seen.numbers, ['7', '12', '19']);
  assert.equal(seen.photos.length, 1);

  const id = body.photos[0].id;
  assert.ok(await t.photos.get(id, 'large', 'shown'), 'published');
  assert.equal(await t.photos.get(id, 'large', 'upload'), undefined, 'no longer an upload');
  assert.equal(await t.store.getUpload(ada.id, id), undefined);

  const feed = await t.call('GET', '/signs');
  assert.deepEqual(
    feed.body.signs.map((s: Json) => s.slug),
    ['exit-7']
  );
});

test('a held post is only its poster’s, with the moderator’s note', async () => {
  const t = await setup();
  t.moderator.post = { verdict: 'hold', reason: 'The photo shows something we keep off the map.', alt: [] };
  const { res, body } = await t.post();
  assert.equal(res.status, 201);
  assert.equal(body.visibility, 'held');
  assert.equal(body.moderation_note, 'The photo shows something we keep off the map.');
  assert.equal(body.photos[0].alt, 'Photo of the Exit 7 sign', 'plain alt text when the moderator wrote none');

  assert.equal((await t.call('GET', '/signs')).body.signs.length, 0);
  assert.equal((await t.call('GET', `/signs/${body.id}`)).res.status, 404);
  assert.equal((await t.call('GET', `/signs/${body.id}`, { as: 'ben' })).res.status, 404);
  const mine = await t.call('GET', `/signs/${body.slug}`, { as: 'ada' });
  assert.equal(mine.res.status, 200);
  assert.equal(mine.body.moderation_note, 'The photo shows something we keep off the map.');

  // Its photos never reach the public folder; only Ada can fetch them, through the API.
  const id = body.photos[0].id;
  assert.equal(await t.photos.get(id, 'large', 'shown'), undefined);
  assert.ok(await t.photos.get(id, 'large', 'held'));
  assert.equal(body.photos[0].url, `https://example.test/api/v1/me/photos/${id}/large`);
  const own = await t.call('GET', `/me/photos/${id}/thumb`, { as: 'ada' });
  assert.equal(own.res.status, 200);
  assert.equal(own.res.headers.get('content-type'), 'image/jpeg');
  assert.equal(own.res.headers.get('cache-control'), 'no-store');
  assert.ok(own.bytes.length > 0);
  assert.equal((await t.call('GET', `/me/photos/${id}/large`, { as: 'ben' })).res.status, 404);
  assert.equal((await t.call('GET', `/me/photos/${id}/large`)).res.status, 401);
  assert.equal((await t.call('GET', `/me/photos/${id}/huge`, { as: 'ada' })).res.status, 400);
});

test('when the moderator can’t answer, nothing is posted and the photos wait', async () => {
  const t = await setup();
  t.moderator.post = 'unavailable';
  const photoId = await t.upload();
  const body = {
    photo_ids: [photoId],
    title: 'Exit 7',
    numbers: [{ value: '7' }],
    place: { label: 'Testville' },
    found_on: '2026-06-01'
  };
  const headers = { 'idempotency-key': 'post-key-0001' };
  const first = await t.call('POST', '/signs', { as: 'ada', body, headers });
  assert.equal(first.res.status, 503);
  assert.equal(first.body.error.code, 'unavailable');
  assert.equal((await t.store.allSigns()).length, 0);
  assert.ok(await t.store.getUpload(ada.id, photoId));

  t.moderator.post = { verdict: 'ok', reason: '', alt: [] };
  const again = await t.call('POST', '/signs', { as: 'ada', body, headers });
  assert.equal(again.res.status, 201, 'the key was let go, so the same post can try again');
  assert.equal(again.body.way_count, 0);
  assert.equal(again.body.first_way, null);
});

test('the same post sent twice with one Idempotency-Key makes one sign', async () => {
  const t = await setup();
  const photoId = await t.upload();
  const body = {
    photo_ids: [photoId],
    title: 'Exit 7',
    numbers: [{ value: '7' }],
    place: { label: 'Testville' },
    found_on: '2026-06-01'
  };
  const headers = { 'idempotency-key': 'post-key-0002' };
  const first = await t.call('POST', '/signs', { as: 'ada', body, headers });
  const second = await t.call('POST', '/signs', { as: 'ada', body, headers });
  assert.equal(first.res.status, 201);
  assert.equal(second.res.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal((await t.store.allSigns()).length, 1);
  assert.equal(t.moderator.posts.length, 1);
  const bad = await t.call('POST', '/signs', { as: 'ada', body, headers: { 'idempotency-key': 'short' } });
  assert.equal(bad.res.status, 400);
});

test('two posts at once can’t share an upload', async () => {
  const t = await setup();
  const photoId = await t.upload();
  const body = (title: string) => ({
    photo_ids: [photoId],
    title,
    numbers: [{ value: '7' }],
    place: { label: 'Testville' },
    found_on: '2026-06-01'
  });
  t.moderator.post = { verdict: 'hold', reason: 'Held', alt: [] };
  const answers = await Promise.all([
    t.call('POST', '/signs', { as: 'ada', body: body('One') }),
    t.call('POST', '/signs', { as: 'ada', body: body('Two') })
  ]);
  assert.deepEqual(answers.map((a) => a.res.status).sort(), [201, 409]);
  const signs = await t.store.allSigns();
  assert.equal(signs.length, 1);
  assert.ok(await t.photos.get(photoId, 'large', 'held'));
  assert.equal(await t.photos.get(photoId, 'large', 'shown'), undefined);
});

test('a post that fails after its photos moved puts them back, so it can be sent again', async () => {
  const t = await setup();
  const photoId = await t.upload();
  const body = {
    photo_ids: [photoId],
    title: 'Exit 7',
    numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
    place: { label: 'Testville' },
    found_on: '2026-06-01',
    way: '7 + 12 = 19'
  };
  const headers = { 'idempotency-key': 'post-key-0003' };
  t.photos.publish = async () => {
    throw new Error('the bucket is down');
  };
  assert.equal((await t.call('POST', '/signs', { as: 'ada', body, headers })).res.status, 500);
  t.photos.publish = MemoryPhotoStore.prototype.publish.bind(t.photos);

  const putWay = t.store.putWay.bind(t.store);
  t.store.putWay = async () => {
    throw new Error('the table is down');
  };
  const failed = await t.call('POST', '/signs', { as: 'ada', body, headers });
  assert.equal(failed.res.status, 500);
  assert.equal((await t.store.allSigns()).length, 0);
  assert.ok(await t.photos.get(photoId, 'large', 'upload'));
  assert.equal(await t.photos.get(photoId, 'large', 'shown'), undefined);

  t.store.putWay = putWay;
  const again = await t.call('POST', '/signs', { as: 'ada', body, headers });
  assert.equal(again.res.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.slug, 'exit-7');
  assert.equal(again.body.way_count, 1);
  assert.ok(await t.photos.get(photoId, 'large', 'shown'));
});

test('a post is made even when clearing its used uploads fails', async () => {
  const t = await setup();
  t.store.deleteUpload = async () => {
    throw new Error('the table is down');
  };
  const { res, body } = await t.post();
  assert.equal(res.status, 201);
  assert.equal((await t.store.allSigns()).length, 1);
  assert.ok(await t.photos.get(body.photos[0].id, 'large', 'shown'));
  const reuse = await t.post({ photo_ids: body.photos.map((p: Json) => p.id), title: 'Again' });
  assert.equal(reuse.res.status, 409, 'its uploads stay taken');
});

test('a sign’s first way is stored before the sign can be seen', async () => {
  const t = await setup();
  const putSign = t.store.putSign.bind(t.store);
  let waysAtPut = -1;
  t.store.putSign = async (sign) => {
    waysAtPut = (await t.store.listWays(sign.id)).length;
    await putSign(sign);
  };
  const { body } = await t.post();
  assert.equal(waysAtPut, 1);
  assert.equal(await t.store.claimWay(body.id, '7 + 12 = 19', 'another'), false, 'its math is held');
});

test('posting needs a name, your own fresh uploads, and true math from the sign', async () => {
  const t = await setup();
  await t.store.updatePlayer(cy.id, { name: '' });
  const nameless = await t.post({}, 'cy');
  assert.equal(nameless.res.status, 400);
  assert.match(nameless.body.error.message, /name/);

  const bensPhoto = await t.upload('ben');
  const notMine = await t.post({ photo_ids: [bensPhoto] });
  assert.equal(notMine.res.status, 400);
  assert.match(notMine.body.error.message, /isn’t one of your uploads/);

  const wrong = await t.post({ way: '7 + 12 = 20' });
  assert.equal(wrong.res.status, 400);
  assert.match(wrong.body.error.message, /Not true/);
  const offSign = await t.post({ way: '7 × 3 = 21' });
  assert.equal(offSign.res.status, 400);
  assert.match(offSign.body.error.message, /3, 21 aren’t on the sign/);

  const cases: Json[] = [
    { title: '' },
    { title: 'x'.repeat(LIMITS.titleMax + 1) },
    { numbers: [] },
    { numbers: [{ value: 'seven' }] },
    { numbers: [{ value: '7', box: [0.9, 0, 0.2, 0.1] }] },
    { place: { label: 'Somewhere', lat: 44 } },
    { place: { label: 'Somewhere', state: 'Minnesota' } },
    { found_on: '2099-01-01' },
    { found_on: '2026-02-30' },
    { finders: [{ handle: 'ada', name: 'Ada' }] },
    { finders: [{ handle: 'nobody' }] },
    { finders: [{ handle: 'ben' }, { handle: 'ben' }] },
    { extra: true }
  ];
  for (const overrides of cases) {
    const { res } = await t.post(overrides);
    assert.equal(res.status, 400, JSON.stringify(overrides));
  }
  assert.equal((await t.store.allSigns()).length, 0);
});

test('finders can be other players and people who don’t play', async () => {
  const t = await setup();
  const { body } = await t.post({
    finders: [
      { handle: 'ben', role: 'spotted' },
      { name: 'Grandma', role: 'found' }
    ]
  });
  assert.deepEqual(body.finders, [
    { name: 'Ben', handle: 'ben', role: 'spotted' },
    { name: 'Grandma', handle: null, role: 'found' }
  ]);
  assert.equal(body.posted_by, 'ada');
  const bens = await t.call('GET', '/players/ben');
  assert.equal(bens.body.sign_count, 1);
});

test('slugs are unique, and never a word a route already uses', async () => {
  const t = await setup();
  assert.equal((await t.post()).body.slug, 'exit-7');
  assert.equal((await t.post()).body.slug, 'exit-7-2');
  const near = await t.post({ title: 'Near' });
  assert.equal(near.body.slug, 'near-2');
  assert.equal((await t.call('GET', '/signs/near-2')).body.title, 'Near');
});

test('another way must be true, from the sign, and new', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const add = (text: string, as = 'ben') => t.call('POST', `/signs/${posted.slug}/ways`, { as, body: { text } });

  const added = await add('19 − 12 = 7');
  assert.equal(added.res.status, 201);
  assert.equal(added.body.way_count, 2);
  assert.deepEqual(added.body.first_way, { text: '7 + 12 = 19', value: '19' });
  assert.deepEqual(
    added.body.ways.map((w: Json) => w.by.handle),
    ['ada', 'ben']
  );

  const again = await add('19-12=7', 'cy');
  assert.equal(again.res.status, 409);
  assert.equal(again.body.error.code, 'conflict');
  assert.equal((await add('7 + 7 = 14')).res.status, 400, 'the sign shows one 7');
  assert.equal((await add('7 + 12')).res.status, 400);
  assert.equal((await t.call('POST', `/signs/${posted.id}/ways`, { body: { text: '7 = 7' } })).res.status, 401);
});

test('the same way sent twice at once is added once, and every new way counts', async () => {
  const t = await setup();
  const { body: posted } = await t.post({ way: undefined });
  const add = (text: string, as: string) => t.call('POST', `/signs/${posted.id}/ways`, { as, body: { text } });
  const same = await Promise.all([add('7 + 12 = 19', 'ben'), add('7+12=19', 'cy')]);
  assert.deepEqual(same.map((a) => a.res.status).sort(), [201, 409]);
  await Promise.all([add('19 − 12 = 7', 'ben'), add('19 − 7 = 12', 'cy')]);
  const sign = (await t.store.getSign(posted.id))!;
  assert.equal(sign.wayCount, 3);
  assert.equal((await t.store.listWays(posted.id)).length, 3);
  assert.ok(sign.firstWay);
});

test('ways sent one after another keep their order, even within a second', async () => {
  const t = await setup();
  const { body: posted } = await t.post({ way: undefined });
  const texts = ['19 − 12 = 7', '19 − 7 = 12', '7 + 12 = 19', '12 + 7 = 19'];
  for (const text of texts) {
    assert.equal((await t.call('POST', `/signs/${posted.id}/ways`, { as: 'ben', body: { text } })).res.status, 201);
  }
  const detail = await t.call('GET', `/signs/${posted.id}`);
  assert.deepEqual(
    detail.body.ways.map((w: Json) => w.text),
    texts
  );
  assert.equal(detail.body.first_way.text, texts[0]);
  assert.equal((await t.call('GET', '/signs')).body.signs[0].first_way.text, texts[0]);
});

test('an unsolved sign gets its first way from whoever solves it', async () => {
  const t = await setup();
  const { body: posted } = await t.post({ way: undefined });
  assert.equal(posted.way_count, 0);
  const added = await t.call('POST', `/signs/${posted.id}/ways`, { as: 'ben', body: { text: '12 + 7 = 19' } });
  assert.deepEqual(added.body.first_way, { text: '12 + 7 = 19', value: '19' });
  assert.equal((await t.call('GET', '/signs')).body.signs[0].way_count, 1);
});

test('only its poster can delete a sign, and its photos go with it', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  assert.equal((await t.call('DELETE', `/signs/${posted.id}`, { as: 'ben' })).res.status, 404);
  assert.equal((await t.call('DELETE', `/signs/${posted.id}`, { as: 'ada' })).res.status, 204);
  assert.equal(await t.store.getSign(posted.id), undefined);
  assert.equal(await t.photos.get(posted.photos[0].id, 'large', 'shown'), undefined);
  assert.equal((await t.post()).body.slug, 'exit-7', 'the slug is free again');
});

test('a sign whose photo can’t be removed stays, to be deleted again', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const remove = t.photos.remove.bind(t.photos);
  t.photos.remove = async () => {
    throw new Error('the bucket is down');
  };
  assert.equal((await t.call('DELETE', `/signs/${posted.id}`, { as: 'ada' })).res.status, 500);
  assert.ok(await t.store.getSign(posted.id));
  t.photos.remove = remove;
  assert.equal((await t.call('DELETE', `/signs/${posted.id}`, { as: 'ada' })).res.status, 204);
  assert.equal(await t.photos.get(posted.photos[0].id, 'large', 'shown'), undefined);
});

test('a report the moderator agrees with hides the sign from everyone but its poster', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  assert.equal(
    (await t.call('POST', `/signs/${posted.id}/report`, { as: 'ada', body: { reason: 'x' } })).res.status,
    400
  );

  t.moderator.report = { verdict: 'hide', reason: 'It is an advertisement.' };
  const report = await t.call('POST', `/signs/${posted.id}/report`, { as: 'ben', body: { reason: 'Spam' } });
  assert.equal(report.res.status, 200);
  assert.deepEqual(report.body, { outcome: 'hidden', note: 'It is an advertisement.' });
  assert.equal(t.moderator.reports[0].reason, 'Spam');
  assert.equal(t.moderator.reports[0].post.photos.length, 1, 'the moderator sees the posted photo');

  assert.equal((await t.call('GET', '/signs')).body.signs.length, 0);
  assert.equal((await t.call('GET', `/signs/${posted.id}`, { as: 'ben' })).res.status, 404);
  const mine = await t.call('GET', `/signs/${posted.id}`, { as: 'ada' });
  assert.equal(mine.body.visibility, 'hidden');
  assert.equal(mine.body.moderation_note, 'It is an advertisement.');

  // Its photos leave the public folder with it.
  const id = posted.photos[0].id;
  assert.equal(await t.photos.get(id, 'large', 'shown'), undefined);
  assert.ok(await t.photos.get(id, 'large', 'held'));
  assert.equal(mine.body.photos[0].thumb_url, `https://example.test/api/v1/me/photos/${id}/thumb`);
  assert.equal((await t.call('GET', `/me/photos/${id}/large`, { as: 'ada' })).res.status, 200);
});

test('a report after a hide that failed partway sees every photo, and a kept one puts them back', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const id = posted.photos[0].id;
  // A hide that moved the photo, then failed (as a CloudFront invalidation can) before the sign changed.
  await t.photos.hide(id);
  t.moderator.report = { verdict: 'keep', reason: 'Fine.' };
  const sent = await t.call('POST', `/signs/${posted.id}/report`, { as: 'ben', body: { reason: 'Spam' } });
  assert.equal(sent.body.outcome, 'kept');
  assert.equal(t.moderator.reports.at(-1)!.post.photos.length, 1);
  assert.ok(await t.photos.get(id, 'large', 'shown'));
  assert.equal(await t.photos.get(id, 'large', 'held'), undefined);
});

test('a kept report puts back a thumbnail a failed hide left in held/', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const id = posted.photos[0].id;
  // S3 moved the thumbnail and failed on the large photo, so the large one is still public.
  t.photos.files.set(`held/${id}/thumb`, t.photos.files.get(`p/${id}/thumb`)!);
  t.photos.files.delete(`p/${id}/thumb`);
  t.moderator.report = { verdict: 'keep', reason: 'Fine.' };
  const sent = await t.call('POST', `/signs/${posted.id}/report`, { as: 'ben', body: { reason: 'Spam' } });
  assert.equal(sent.body.outcome, 'kept');
  assert.ok(await t.photos.get(id, 'thumb', 'shown'));
  assert.ok(await t.photos.get(id, 'large', 'shown'));
  assert.equal(await t.photos.get(id, 'thumb', 'held'), undefined);
});

test('two reports of one sign at once are looked at one after the other', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const send = (as: string) => t.call('POST', `/signs/${posted.id}/report`, { as, body: { reason: 'Spam' } });
  const both = await Promise.all([send('ben'), send('cy')]);
  assert.deepEqual(both.map((r) => r.res.status).sort(), [200, 409]);
  assert.equal(t.moderator.reports.length, 1);
  assert.equal((await send(both[0].res.status === 409 ? 'ben' : 'cy')).res.status, 200, 'the lease is given back');
});

test('a kept report is answered once per player', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  const send = () => t.call('POST', `/signs/${posted.id}/report`, { as: 'ben', body: { reason: 'I don’t like it' } });
  const first = await send();
  assert.deepEqual(first.body, { outcome: 'kept', note: 'Nothing wrong with it.' });
  t.moderator.report = { verdict: 'hide', reason: 'changed its mind' };
  assert.deepEqual((await send()).body, first.body);
  assert.equal(t.moderator.reports.length, 1);
  assert.equal((await t.call('GET', '/signs')).body.signs.length, 1);
});

test('a moderator that can’t answer a report leaves the sign as it was', async () => {
  const t = await setup();
  const { body: posted } = await t.post();
  t.moderator.report = 'unavailable';
  const sent = await t.call('POST', `/signs/${posted.id}/report`, { as: 'ben', body: { reason: 'Spam' } });
  assert.equal(sent.res.status, 503);
  assert.equal(await t.store.getReport(posted.id, ben.id), undefined);
  assert.equal((await t.call('GET', '/signs')).body.signs.length, 1);
});

test('blocking a player hides their signs and ways from you alone', async () => {
  const t = await setup();
  const { body: bens } = await t.post({ title: 'Ben’s sign' }, 'ben');
  const { body: adas } = await t.post({ title: 'Ada’s sign' }, 'ada');
  await t.call('POST', `/signs/${adas.id}/ways`, { as: 'ben', body: { text: '19 − 7 = 12' } });

  assert.equal((await t.call('POST', '/players/ada/block', { as: 'ada' })).res.status, 400);
  assert.equal((await t.call('POST', '/players/nobody/block', { as: 'ada' })).res.status, 404);
  assert.equal((await t.call('POST', '/players/ben/block', { as: 'ada' })).res.status, 204);

  const feed = await t.call('GET', '/signs', { as: 'ada' });
  assert.deepEqual(
    feed.body.signs.map((s: Json) => s.id),
    [adas.id]
  );
  assert.equal((await t.call('GET', `/signs/${bens.id}`, { as: 'ada' })).res.status, 404);
  const detail = await t.call('GET', `/signs/${adas.id}`, { as: 'ada' });
  assert.deepEqual(
    detail.body.ways.map((w: Json) => w.by.handle),
    ['ada']
  );
  assert.equal((await t.call('GET', '/signs', { as: 'cy' })).body.signs.length, 2, 'others still see both');
  assert.deepEqual((await t.call('GET', '/me/blocks', { as: 'ada' })).body, {
    players: [{ handle: 'ben', name: 'Ben' }]
  });

  assert.equal((await t.call('DELETE', '/players/ben/block', { as: 'ada' })).res.status, 204);
  assert.equal((await t.call('GET', '/signs', { as: 'ada' })).body.signs.length, 2);
});

test('a blocked player’s first way is left out of the sign’s summary too', async () => {
  const t = await setup();
  const { body: posted } = await t.post({ way: undefined }, 'ada');
  await t.call('POST', `/signs/${posted.id}/ways`, { as: 'ben', body: { text: '19 − 7 = 12' } });
  await t.call('POST', `/signs/${posted.id}/ways`, { as: 'cy', body: { text: '7 + 12 = 19' } });
  await t.call('POST', '/players/ben/block', { as: 'ada' });

  const detail = await t.call('GET', `/signs/${posted.id}`, { as: 'ada' });
  assert.deepEqual(detail.body.first_way, { text: '7 + 12 = 19', value: '19' });
  assert.equal(detail.body.way_count, 1);
  const feed = await t.call('GET', '/signs', { as: 'ada' });
  assert.equal(feed.body.signs[0].first_way, null);
  const others = await t.call('GET', '/signs', { as: 'cy' });
  assert.deepEqual(others.body.signs[0].first_way, { text: '19 − 7 = 12', value: '12' });
  assert.equal('player_id' in others.body.signs[0].first_way, false, 'who found it stays out');
});

test('a replayed post leaves out the ways of players its poster blocked since', async () => {
  const t = await setup();
  const headers = { 'idempotency-key': 'post-key-0004' };
  const { body: posted } = await t.post({}, 'ada', headers);
  await t.call('POST', `/signs/${posted.id}/ways`, { as: 'ben', body: { text: '19 − 12 = 7' } });
  assert.equal((await t.call('POST', '/players/ben/block', { as: 'ada' })).res.status < 300, true);
  const replay = await t.call('POST', '/signs', {
    as: 'ada',
    headers,
    body: {
      photo_ids: posted.photos.map((p: Json) => p.id),
      title: 'Exit 7',
      numbers: [{ value: '7' }],
      place: { label: 'Testville' },
      found_on: '2026-06-01'
    }
  });
  assert.equal(replay.res.status, 201);
  assert.equal(replay.body.id, posted.id);
  assert.deepEqual(
    replay.body.ways.map((w: Json) => w.by.handle),
    ['ada']
  );
});

test('a new way doesn’t bring back a sign a report hid', async () => {
  const t = await setup();
  await t.store.putSign(sign({ id: '01JS0000000000000000000009', title: 'Hidden', postedBy: ben.id }));
  const before = (await t.store.getSign('01JS0000000000000000000009'))!;
  await t.store.updateSign(before.id, { visibility: 'hidden', moderation: { note: 'No.', at: before.postedAt } });
  // A way added from a copy read before the hide only changes the way fields.
  await t.store.updateSign(before.id, { wayCount: 2, firstWay: before.firstWay });
  const after = (await t.store.getSign(before.id))!;
  assert.equal(after.visibility, 'hidden');
  assert.equal(after.wayCount, 2);
});

test('deleting an account takes its posted photos and its reports with it', async () => {
  const t = await setup();
  const { body: adas } = await t.post({ title: 'Ada’s sign' }, 'ada');
  const { body: bens } = await t.post({ title: 'Ben’s sign' }, 'ben');
  await t.call('POST', `/signs/${bens.id}/report`, { as: 'ada', body: { reason: 'Spam' } });
  assert.ok(await t.store.getReport(bens.id, ada.id));
  assert.equal((await t.call('DELETE', '/me', { as: 'ada' })).res.status, 204);
  assert.equal(await t.photos.get(adas.photos[0].id, 'large', 'shown'), undefined);
  assert.equal(await t.store.getReport(bens.id, ada.id), undefined);
  assert.ok(await t.photos.get(bens.photos[0].id, 'large', 'shown'));
});

test('each kind of post has a daily limit', async () => {
  const t = await setup();
  const now = nowSeconds();
  for (let i = 0; i < LIMITS.uploadsADay; i++) await t.store.bump(`uploads:${ada.id}`, 86400, now);
  const upload = await t.call('POST', '/photos', { as: 'ada', raw: await photo() });
  assert.equal(upload.res.status, 429);
  for (let i = 0; i < LIMITS.postsADay; i++) await t.store.bump(`posts:${ben.id}`, 86400, now);
  const posted = await t.post({}, 'ben');
  assert.equal(posted.res.status, 429);
  assert.equal(t.moderator.posts.length, 0, 'the moderator isn’t asked once the limit is reached');
});
