// The API's edges: sign-in limits and sessions, ids in any case, the caches' key, invisible
// characters in what players type, states, and photos sent with no length or the wrong label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import { bodyUpTo, text } from '../src/api/input.ts';
import { LIMITS as SIGN_IN, SESSION_IDLE, SESSION_TOUCH } from '../src/auth/auth.ts';
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
const ch = (...points: number[]): string => String.fromCodePoint(...points);

const photo = (format: 'jpeg' | 'png' | 'webp' = 'jpeg') =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#f2b300' } })
    .toFormat(format)
    .toBuffer();

async function setup() {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const tinylytics = new FakeTinylytics();
  let ip = '192.0.2.1';
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => ip,
    tinylytics
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben]) {
    await addPlayer(store, player);
    const secret = player.handle.padEnd(43, 'x');
    const now = new Date().toISOString();
    await store.putSession({
      playerId: player.id,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: nowSeconds() + 3600
    });
    tokens[player.handle] = `rsm_${player.id}_${secret}`;
  }
  await addSign(store, sign({ id: EXIT, title: 'Exit Seven' }));
  const call = async (
    method: string,
    path: string,
    options: { as?: string; body?: unknown; raw?: Buffer | ReadableStream<Uint8Array>; type?: string } = {}
  ) => {
    const headers: Record<string, string> = {};
    if (options.as) headers.authorization = `Bearer ${tokens[options.as]}`;
    let body: ReadableStream<Uint8Array> | Uint8Array | string | undefined;
    if (options.raw) {
      headers['content-type'] = options.type ?? 'image/jpeg';
      body = options.raw instanceof ReadableStream ? options.raw : new Uint8Array(options.raw);
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body };
    if (options.raw instanceof ReadableStream) init.duplex = 'half';
    const res = await app.request(`/api/v1${path}`, init);
    const bytes = await res.text();
    return { res, body: (bytes ? JSON.parse(bytes) : null) as Json };
  };
  const upload = async () => {
    const { res, body } = await call('POST', '/photos', { as: 'ada', raw: await photo() });
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.id as string;
  };
  const post = async (overrides: Json = {}) =>
    call('POST', '/signs', {
      as: 'ada',
      body: {
        photo_ids: [await upload()],
        title: 'Exit 7',
        numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
        place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
        found_on: '2026-06-01',
        way: '7 + 12 = 19',
        ...overrides
      }
    });
  return { store, mailer, call, post, tokens, setIp: (next: string) => (ip = next) };
}

// ---------------------------------------------------------------------------------------------
// Sign-in

test('a network over its limit uses up none of an address’s sign-in emails', async () => {
  const t = await setup();
  t.setIp('198.51.100.7');
  for (let i = 0; i < SIGN_IN.network; i++)
    await t.call('POST', '/auth/start', { body: { email: `p${i}@example.com` } });
  // The busy network asks for someone else's address, again and again.
  for (let i = 0; i < SIGN_IN.address + 2; i++) {
    assert.equal((await t.call('POST', '/auth/start', { body: { email: 'owner@example.com' } })).res.status, 429);
  }
  // Its owner, elsewhere, still gets every one of theirs.
  t.setIp('203.0.113.9');
  for (let i = 0; i < SIGN_IN.address; i++) {
    assert.equal((await t.call('POST', '/auth/start', { body: { email: 'owner@example.com' } })).res.status, 202);
  }
  assert.equal((await t.call('POST', '/auth/start', { body: { email: 'owner@example.com' } })).res.status, 429);
});

test('sign-in emails stop at 200 an hour in all, across every network and address', async () => {
  const t = await setup();
  assert.equal(SIGN_IN.total, 200);
  for (let i = 0; i < SIGN_IN.total; i++) {
    t.setIp(`10.0.${Math.floor(i / 100)}.${i % 100}`);
    const { res } = await t.call('POST', '/auth/start', { body: { email: `player${i}@example.com` } });
    assert.equal(res.status, 202, `email ${i}`);
  }
  t.setIp('10.9.9.9');
  const over = await t.call('POST', '/auth/start', { body: { email: 'one-more@example.com' } });
  assert.equal(over.res.status, 429);
  assert.equal(over.body.error.code, 'rate_limited');
  assert.equal(t.mailer.sent.length, SIGN_IN.total);
});

test('a session lasts 180 days from its last use, pushed back at most once a day', async () => {
  const t = await setup();
  assert.equal(SESSION_IDLE, 180 * 86400);
  const hash = createHash('sha256').update('ada'.padEnd(43, 'x')).digest('hex');
  const now = nowSeconds();
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();

  // Used within the day: left as it was.
  await t.store.putSession({
    playerId: ada.id,
    secretHash: hash,
    createdAt: at(now - 3600),
    lastUsedAt: at(now - 3600),
    expiresAt: now + 100
  });
  assert.equal((await t.call('GET', '/me', { as: 'ada' })).res.status, 200);
  assert.equal((await t.store.getSession(ada.id, hash))!.expiresAt, now + 100);

  // Last used two days ago: it slides to 180 days from now.
  const old = now - 2 * SESSION_TOUCH;
  await t.store.putSession({
    playerId: ada.id,
    secretHash: hash,
    createdAt: at(old),
    lastUsedAt: at(old),
    expiresAt: old + SESSION_IDLE
  });
  assert.equal((await t.call('GET', '/me', { as: 'ada' })).res.status, 200);
  const slid = (await t.store.getSession(ada.id, hash))!;
  assert.ok(Math.abs(slid.expiresAt - (nowSeconds() + SESSION_IDLE)) <= 2, String(slid.expiresAt));
  assert.ok(Date.parse(slid.lastUsedAt) / 1000 >= now - 2);

  // Unused for 180 days: it has ended.
  const gone = now - SESSION_IDLE - 1;
  await t.store.putSession({
    playerId: ada.id,
    secretHash: hash,
    createdAt: at(gone),
    lastUsedAt: at(gone),
    expiresAt: gone + SESSION_IDLE
  });
  assert.equal((await t.call('GET', '/me', { as: 'ada' })).res.status, 401);
});

// ---------------------------------------------------------------------------------------------
// Routes and caches

test('a heart given before its sign was hidden is taken back by the id in any case', async () => {
  const t = await setup();
  // Ben's heart on Ada's sign: once it is hidden, only its poster can see it.
  for (const key of [EXIT.toLowerCase(), EXIT]) {
    await t.store.updateSign(EXIT, { visibility: 'shown' });
    assert.equal((await t.call('PUT', `/signs/${EXIT}/heart`, { as: 'ben' })).body.hearted, true);
    await t.store.updateSign(EXIT, { visibility: 'hidden' });
    const off = await t.call('DELETE', `/signs/${key}/heart`, { as: 'ben' });
    assert.equal(off.res.status, 200, `${key}: ${JSON.stringify(off.body)}`);
    assert.equal(off.body.hearted, false);
    assert.deepEqual(await t.store.listHearts(ben.id), []);
  }
});

test('API answers vary on Authorization, cached or not', async () => {
  const t = await setup();
  const open = await t.call('GET', '/signs');
  assert.equal(open.res.headers.get('Cache-Control'), 'public, max-age=60');
  assert.match(open.res.headers.get('Vary') ?? '', /\bAuthorization\b/);
  const mine = await t.call('GET', '/signs', { as: 'ada' });
  assert.equal(mine.res.headers.get('Cache-Control'), 'no-store');
  assert.match(mine.res.headers.get('Vary') ?? '', /\bAuthorization\b/);
});

// ---------------------------------------------------------------------------------------------
// What players type

test('text refuses characters that turn its direction, in every field a player types', async () => {
  const t = await setup();
  const rlo = ch(0x202e);
  for (const turn of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.throws(() => text(`ab${ch(turn)}c`, 'title', 80, 1), /direction/, turn.toString(16));
  }
  const cases: [string, Json][] = [
    ['title', { title: `Exit ${rlo}7` }],
    ['caption', { caption: `Nice ${rlo}one` }],
    ['place.label', { place: { label: `Test${rlo}ville`, state: 'MN' } }],
    ['numbers[0].text', { numbers: [{ value: '7', text: `EXIT ${rlo}7` }, { value: '12' }, { value: '19' }] }],
    ['finders[0].name', { finders: [{ name: `Cy${rlo}`, role: 'spotted' }] }]
  ];
  for (const [field, overrides] of cases) {
    const { res, body } = await t.post(overrides);
    assert.equal(res.status, 400, field);
    assert.match(body.error.message, new RegExp(`^${field.replace(/[[\].]/g, '\\$&')} .*direction`), field);
  }
  const way = await t.post({ way: `7 + 12 = 1${rlo}9` });
  assert.ok(way.res.status >= 400 && way.res.status < 500, String(way.res.status));
  for (const [field, body] of [
    ['name', { name: `Ada${rlo}` }],
    ['bio', { bio: `Counts${ch(0x2067)} everything` }]
  ] as const) {
    const res = await t.call('PATCH', '/me', { as: 'ada', body });
    assert.equal(res.res.status, 400, field);
    assert.match(res.body.error.message, /direction/);
  }
});

test('invisible characters are dropped from text, and emoji keep their joiners', async () => {
  for (const hidden of [0x200b, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad, 0x061c, 0xe0041]) {
    assert.equal(text(`Ad${ch(hidden)}a`, 'name', 40, 1), 'Ada', hidden.toString(16));
  }
  // Only invisible characters is no name at all.
  assert.throws(() => text(ch(0x200b, 0x200b), 'name', 40, 1), /name is 1 to 40/);
  const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const england = ch(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
  const keycap = ch(0x0037, 0xfe0f, 0x20e3);
  const heart = ch(0x2764, 0xfe0f);
  const persian = ch(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645);
  for (const kept of [family, england, keycap, heart, persian, `Road trip ${family} ${england}`]) {
    assert.equal(text(kept, 'caption', 280, 0), kept);
  }

  const t = await setup();
  const done = await t.call('PATCH', '/me', { as: 'ada', body: { name: `Ada${ch(0x200b)} ${family}` } });
  assert.equal(done.res.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.name, `Ada ${family}`);
});

// ---------------------------------------------------------------------------------------------
// States

test('a sign’s state is a US state, DC or a territory; other capitals are left off, never refused', async () => {
  const t = await setup();
  for (const state of ['MN', 'DC', 'PR', 'GU', 'VI', 'AS', 'MP']) {
    const { res, body } = await t.post({ title: `Exit in ${state}`, place: { label: `Town, ${state}`, state } });
    assert.equal(res.status, 201, `${state}: ${JSON.stringify(body)}`);
    assert.equal(body.place.state, state);
  }
  const unknown = await t.post({ title: 'Exit nowhere', place: { label: 'Town, ZZ', state: 'ZZ' } });
  assert.equal(unknown.res.status, 201, JSON.stringify(unknown.body));
  assert.equal(unknown.body.place.state, null);
  assert.equal(unknown.body.place.label, 'Town, ZZ');
  for (const state of ['mn', 'MNN', 7]) {
    const { res } = await t.post({ title: 'Exit odd', place: { label: 'Town', state } });
    assert.equal(res.status, 400, String(state));
  }
});

// ---------------------------------------------------------------------------------------------
// Photos

/** A body sent in 64 KB pieces with no length, counting how much the server asked for. */
function stream(total: number) {
  const piece = 64 * 1024;
  const sent = { bytes: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent.bytes >= total) return controller.close();
      const size = Math.min(piece, total - sent.bytes);
      sent.bytes += size;
      controller.enqueue(new Uint8Array(size));
    }
  });
  return { body, sent };
}

test('a body with no length is read only until it passes the limit', async () => {
  const small = stream(100_000);
  assert.equal(
    (
      await bodyUpTo(
        new Request('https://x.test', { method: 'POST', body: small.body, duplex: 'half' } as RequestInit),
        1_000_000
      )
    ).byteLength,
    100_000
  );
  const huge = stream(50 * 1024 * 1024);
  const read = await bodyUpTo(
    new Request('https://x.test', { method: 'POST', body: huge.body, duplex: 'half' } as RequestInit),
    1_000_000
  );
  assert.ok(read.byteLength > 1_000_000 && read.byteLength <= 1_000_000 + 64 * 1024, String(read.byteLength));
  assert.ok(huge.sent.bytes < 2_000_000, `pulled ${huge.sent.bytes}`);
});

test('an upload or profile photo with no Content-Length past the limit is refused unread', async () => {
  const t = await setup();
  for (const [method, path] of [
    ['POST', '/photos'],
    ['PUT', '/me/avatar']
  ]) {
    const { body: raw, sent } = stream(LIMITS.photoBytes * 4);
    const { res, body } = await t.call(method, path, { as: 'ada', raw });
    assert.equal(res.status, 413, path);
    assert.equal(body.error.code, 'too_large');
    assert.ok(sent.bytes < LIMITS.photoBytes * 2, `${path} pulled ${sent.bytes}`);
  }
});

test('an oversized real photo is refused, with or without a Content-Length', async () => {
  const t = await setup();
  // Noise doesn't compress, so this PNG is past the limit.
  const side = 1400;
  const noise = Buffer.alloc(side * side * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const big = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  assert.ok(big.length > LIMITS.photoBytes, String(big.length));
  const sized = await t.call('POST', '/photos', { as: 'ada', raw: big, type: 'image/png' });
  assert.equal(sized.res.status, 413);
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(big));
      controller.close();
    }
  });
  assert.equal((await t.call('POST', '/photos', { as: 'ada', raw: streamed, type: 'image/png' })).res.status, 413);
});

test('a photo’s bytes must be a JPEG, PNG or WebP, whatever its label says', async () => {
  const t = await setup();
  // A real photo under another of the three labels is still taken, and kept as a JPEG.
  for (const [format, type] of [
    ['png', 'image/jpeg'],
    ['jpeg', 'image/png'],
    ['webp', 'image/jpeg']
  ] as const) {
    const { res, body } = await t.call('POST', '/photos', { as: 'ada', raw: await photo(format), type });
    assert.equal(res.status, 201, `${format} as ${type}: ${JSON.stringify(body)}`);
  }
  // Bytes of a kind we don't take are refused, labelled as one we do.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48"/></svg>'
  );
  const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
    .gif()
    .toBuffer();
  const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
    .tiff()
    .toBuffer();
  for (const [name, bytes] of [
    ['svg', svg],
    ['gif', gif],
    ['tiff', tiff]
  ] as const) {
    const upload = await t.call('POST', '/photos', { as: 'ada', raw: bytes, type: 'image/jpeg' });
    assert.equal(upload.res.status, 400, name);
    assert.match(upload.body.error.message, /couldn’t be read/);
    const avatar = await t.call('PUT', '/me/avatar', { as: 'ada', raw: bytes, type: 'image/png' });
    assert.equal(avatar.res.status, 400, name);
  }
});
