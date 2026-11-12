// The product dashboard's log lines (src/product.ts) and the hourly census (src/census.ts):
// what each thing a player does logs, that no line can carry a person, and that the census
// counts, takes its lease once an hour and never gets in a request's way. Fictional players and
// signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { Census, CENSUS_RETRY, countCensus, type CensusLine } from '../src/census.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer, type Mail, type Mailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { FAILURES, PRODUCT_FIELDS, productLine, productLog, type ProductLine } from '../src/product.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { FakeTinylytics } from './support/tinylytics.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const S1 = '01JS0000000000000000000001';
const S2 = '01JS0000000000000000000002';

const cy: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cy',
  name: 'Cy',
  avatarColor: '#B01C33',
  email: 'cy@example.com',
  createdAt: '2026-01-03T00:00:00.000Z'
};

test('the fields a product line may carry are these and no others', () => {
  // A new field is a change to what the dashboard may see: it goes here on purpose, and is never
  // an email, a name, a handle, a player or sign id, an address or anything a player typed.
  assert.deepEqual(Object.keys(PRODUCT_FIELDS).sort(), [
    'action',
    'event',
    'first',
    'front',
    'numbers',
    'outcome',
    'part',
    'photos',
    'solved'
  ]);
  for (const [field, allowed] of Object.entries(PRODUCT_FIELDS)) {
    if (Array.isArray(allowed)) {
      for (const word of allowed) assert.match(word, /^[a-z-]+$/, `${field}: ${word}`);
    } else {
      assert.ok(allowed === 'count' || allowed === 'flag', field);
    }
  }
  assert.deepEqual(FAILURES, { moderator: ['unavailable', 'refused', 'ceiling'], 'signin-mail': ['unsent'] });
});

test('a product line drops any field or word it doesn’t know', () => {
  const sneaky = {
    action: 'way',
    front: 'quiz',
    outcome: 'new',
    email: 'cy@example.com',
    handle: 'cy',
    playerId: cy.id,
    signId: S1,
    event: 'census'
  } as unknown as ProductLine;
  assert.deepEqual(productLine(sneaky), { event: 'product', action: 'way', front: 'quiz', outcome: 'new' });
  const bad = { action: 'sign', front: 'Cy', outcome: 'cy@example.com', photos: 2.5, numbers: -1, solved: 'yes' };
  assert.deepEqual(productLine(bad as unknown as ProductLine), { event: 'product', action: 'sign' });
  assert.deepEqual(
    productLine({ action: 'sign', front: 'app', outcome: 'held', photos: 2, numbers: 3, solved: true }),
    {
      event: 'product',
      action: 'sign',
      front: 'app',
      outcome: 'held',
      photos: 2,
      numbers: 3,
      solved: true
    }
  );
});

class FailingMailer implements Mailer {
  async send(_mail: Mail): Promise<void> {
    throw new Error('Rejected: cy@example.com is not verified');
  }
}

async function setup(options: { mailer?: Mailer } = {}) {
  const store = new MemoryStore();
  const mailer = options.mailer ?? new MemoryMailer();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator,
    tinylytics: new FakeTinylytics(),
    feedbackTo: 'owner@example.test',
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
  await store.putSign(sign({ id: S1, title: 'Seven Twelve' }));
  await store.putWay(way(S1));
  await store.putSign(sign({ id: S2, title: 'Open Road', firstWay: undefined, wayCount: 0 }));
  const call = async (method: string, path: string, as?: string, body?: unknown, raw?: Buffer) => {
    const headers: Record<string, string> = {};
    if (as) headers.authorization = `Bearer ${tokens[as]}`;
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
  return { store, mailer, moderator, call };
}

/** Runs `work` with the product lines and console lines it logs caught. */
async function catching(work: () => Promise<void>) {
  const lines: Record<string, unknown>[] = [];
  const logged: unknown[] = [];
  const write = productLog.write;
  const { info, error, log } = console;
  productLog.write = (line) => void lines.push(line);
  console.info = (...a: unknown[]) => void logged.push(a);
  console.error = (...a: unknown[]) => void logged.push(a);
  console.log = (...a: unknown[]) => void logged.push(a);
  try {
    await work();
  } finally {
    productLog.write = write;
    Object.assign(console, { info, error, log });
  }
  return { lines, logged };
}

/** No line names anyone or anything a player made. */
function assertNobody(lines: unknown[]) {
  const text = JSON.stringify(lines);
  for (const p of [ada, ben, cy]) {
    for (const value of [p.id, p.handle, p.name, p.email].filter(Boolean)) {
      assert.ok(!text.includes(`"${value}"`) && !text.includes(value!.toLowerCase() + '@'), `${value} in ${text}`);
    }
  }
  assert.ok(!text.includes('@'), text);
  assert.ok(!text.includes(S1) && !text.includes(S2) && !text.includes('seven-twelve'), text);
}

test('each thing a player does through the app logs one product line, and none names anyone', async () => {
  const t = await setup();
  const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#f2b300' } })
    .jpeg()
    .toBuffer();
  const { lines } = await catching(async () => {
    // A new player signs in by code, then names themselves.
    const started = await t.call('POST', '/auth/start', undefined, { email: 'dee@example.com' });
    assert.equal(started.res.status, 202);
    const mail = (t.mailer as MemoryMailer).sent.at(-1)!;
    const code = /code is (\d{6})/.exec(mail.subject)![1];
    const verified = await t.call('POST', '/auth/verify', undefined, { login_id: started.body.login_id, code });
    assert.equal(verified.res.status, 200);
    assert.equal((await t.call('PATCH', '/me', 'cy', { bio: 'Likes exits.' })).res.status, 200);
    // A post, held by the moderator.
    const upload = await t.call('POST', '/photos', 'cy', undefined, photo);
    t.moderator.post = { verdict: 'hold', reason: 'Looks off.', alt: [] };
    const posted = await t.call('POST', '/signs', 'cy', {
      photo_ids: [upload.body.id],
      title: 'Exit 7',
      numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
      place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
      found_on: '2026-06-01',
      way: '7 + 12 = 19'
    });
    assert.equal(posted.res.status, 201, JSON.stringify(posted.body));
    // A new way, a way found too, a heart given and taken back.
    assert.equal((await t.call('POST', `/signs/${S2}/ways`, 'ben', { text: '7 + 12 = 19' })).res.status, 201);
    const solved = await t.call('POST', `/signs/${S1}/solve`, 'ben', { text: '7 + 12 = 19' });
    assert.equal(solved.body.result, 'also_found');
    assert.equal((await t.call('PUT', `/signs/${S1}/heart`, 'ben')).res.status, 200);
    assert.equal((await t.call('DELETE', `/signs/${S1}/heart`, 'ben')).res.status, 200);
    // A report the moderator keeps, a duplicate, feedback, then Cy leaves.
    assert.equal((await t.call('POST', `/signs/${S1}/report`, 'cy', { reason: 'Not a real sign' })).res.status, 200);
    assert.equal((await t.call('POST', `/signs/${S1}/duplicate`, 'cy', { same_as: S2 })).res.status, 200);
    assert.equal((await t.call('POST', '/feedback', 'cy', { message: 'Love it' })).res.status, 202);
    assert.equal((await t.call('DELETE', '/me', 'cy')).res.status, 204);
  });
  assert.deepEqual(lines, [
    { event: 'product', action: 'signin-start', front: 'app' },
    { event: 'product', action: 'signin-finish', front: 'app', outcome: 'new' },
    { event: 'product', action: 'profile', part: 'bio', first: false },
    { event: 'product', action: 'sign', front: 'app', outcome: 'held', photos: 1, numbers: 3, solved: true },
    { event: 'product', action: 'way', front: 'app', outcome: 'new' },
    { event: 'product', action: 'way', front: 'app', outcome: 'found-too' },
    { event: 'product', action: 'heart', front: 'app', outcome: 'given' },
    { event: 'product', action: 'heart', front: 'app', outcome: 'taken-back' },
    { event: 'product', action: 'report', front: 'app', outcome: 'kept' },
    { event: 'product', action: 'duplicate', front: 'app' },
    { event: 'product', action: 'feedback', front: 'app' },
    { event: 'product', action: 'account-deleted' }
  ]);
  for (const line of lines) {
    for (const [field, value] of Object.entries(line)) {
      const allowed = (PRODUCT_FIELDS as Record<string, unknown>)[field];
      assert.ok(allowed !== undefined, field);
      if (Array.isArray(allowed)) assert.ok(allowed.includes(value), `${field}: ${String(value)}`);
    }
  }
  assertNobody(lines);
});

test('a first name says so; refusals and repeats log nothing', async () => {
  const t = await setup();
  await t.store.updatePlayer(cy.id, { name: '' });
  const { lines } = await catching(async () => {
    assert.equal((await t.call('PATCH', '/me', 'cy', { name: 'Cy Rider' })).res.status, 200);
    // The same again changes nothing; a way that isn't true and your own way again are refused.
    assert.equal((await t.call('PATCH', '/me', 'cy', { name: 'Cy Rider' })).res.status, 200);
    assert.equal((await t.call('POST', `/signs/${S1}/solve`, 'ada', { text: '7 + 12 = 19' })).res.status, 409);
    assert.equal((await t.call('POST', `/signs/${S2}/ways`, 'ben', { text: '7 + 12 = 20' })).res.status, 400);
  });
  assert.deepEqual(lines, [{ event: 'product', action: 'profile', part: 'name', first: true }]);
});

test('failures are counted lines by kind and outcome, with no address', async () => {
  const t = await setup({ mailer: new FailingMailer() });
  const { lines, logged } = await catching(async () => {
    const started = await t.call('POST', '/auth/start', undefined, { email: 'dee@example.com' });
    assert.equal(started.res.status, 500, 'the answer is what it was before');
    t.moderator.report = 'unavailable';
    const report = await t.call('POST', `/signs/${S1}/report`, 'cy', { reason: 'Not a real sign' });
    assert.equal(report.res.status, 503);
  });
  assert.deepEqual(lines, []);
  const events = logged.map((args) => (args as unknown[])[0]).filter((e) => typeof e === 'object' && e && 'event' in e);
  assert.deepEqual(events, [
    { event: 'signin-mail', outcome: 'unsent', op: 'app' },
    { event: 'moderator', outcome: 'unavailable', op: 'report' }
  ]);
  assert.ok(!JSON.stringify(events).includes('@'));
});

test('the census counts players, signs and ways, and names nobody', async () => {
  const t = await setup();
  await t.store.putSign(sign({ id: '01JS0000000000000000000003', title: 'Old One', foundOn: '2007-05-01' }));
  await t.store.putSign(sign({ id: '01JS0000000000000000000004', title: 'Held Back', visibility: 'held' }));
  await t.store.putWay(way(S1, { id: 'w2', playerId: ben.id, text: '19 − 12 = 7', value: '7' }));
  await t.store.addCoFind(
    { signId: S1, wayId: 'w2', playerId: cy.id, createdAt: '2026-01-02T00:00:00.000Z', via: 'quiz' },
    (await t.store.listWays(S1)).find((w) => w.id === 'w2')!
  );
  const quizSecret = 'q'.padEnd(43, 'q');
  await t.store.putSession({
    playerId: ada.id,
    via: 'quiz',
    secretHash: createHash('sha256').update(quizSecret).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: new Date().toISOString(),
    expiresAt: nowSeconds() + 3600
  });
  const line = await countCensus(t.store);
  assert.deepEqual(line, {
    event: 'census',
    players: 3,
    playersNamed: 3,
    playersPlaying: 3,
    playersApp: 3,
    playersQuiz: 1,
    playersBoth: 1,
    signsShown: 3,
    signsHeld: 1,
    signsHidden: 0,
    signsFirstEra: 1,
    signsNewEra: 2,
    ways: 2,
    coFinds: 1,
    signsUnsolved: 2,
    signsOneWay: 0
  } satisfies CensusLine);
  assertNobody([line]);
});

test('the census runs once an hour across instances, tries rarely, and never fails a request', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  let now = nowSeconds();
  const logged: CensusLine[] = [];
  const one = new Census(
    store,
    () => now,
    (line) => logged.push(line)
  );
  const two = new Census(
    store,
    () => now,
    (line) => logged.push(line)
  );
  assert.equal(await one.run(), 'counted');
  assert.equal(await two.run(), 'held', 'the other instance finds the hour taken');
  assert.equal(await two.run(), 'waiting', 'and doesn’t ask again for a while');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].players, 1);

  // A store that fails: the census says so and the request answers as ever.
  const broken = new MemoryStore();
  broken.lease = async () => {
    throw new Error('table down');
  };
  const census = new Census(broken, () => now);
  assert.equal(await census.run(), 'failed');
  now += CENSUS_RETRY;
  const app = createApp({
    store: broken,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    census: true
  });
  const res = await app.request('/api/v1/badges');
  assert.equal(res.status, 200);

  // A count that never ends holds the request no longer than the wait.
  const stuck = new MemoryStore();
  stuck.allSigns = () => new Promise(() => {});
  const slow = new Census(
    stuck,
    () => now,
    () => {},
    20
  );
  let answered = false;
  const handler = slow.middleware();
  const started = Date.now();
  await handler({} as never, async () => {
    answered = true;
  });
  assert.ok(answered);
  assert.ok(Date.now() - started < 1000, 'the request went on without the count');
});

test('Quiz logs its sends as quiz, and a skip only when the sign left was unsolved', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await addPlayer(store, ben);
  const secret = 'ben'.padEnd(43, 'x');
  await store.putSession({
    playerId: ben.id,
    via: 'quiz',
    secretHash: createHash('sha256').update(secret).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: new Date().toISOString(),
    expiresAt: nowSeconds() + 3600
  });
  await store.putSign(sign({ id: S1, title: 'Seven Twelve' }));
  await store.putWay(way(S1));
  await store.putSign(sign({ id: S2, title: 'Open Road', firstWay: undefined, wayCount: 0 }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    quizOpen: true
  });
  const quiz = (path: string, form?: Record<string, string>) =>
    app.request(path, {
      method: form ? 'POST' : 'GET',
      headers: {
        'X-RSM-Front': 'quiz',
        cookie: `rsm_quiz=rsm_${ben.id}_${secret}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://quiz.example.test' } : {})
      },
      body: form ? new URLSearchParams(form).toString() : undefined
    });
  const { lines } = await catching(async () => {
    assert.equal((await quiz(`/next?after=${S1}`)).status, 303);
    assert.equal((await quiz('/signs/open-road/solve', { text: '7 + 12 = 19' })).status, 303);
    assert.equal((await quiz('/signs/seven-twelve/solve', { text: '7 + 12 = 19' })).status, 303);
    assert.equal((await quiz(`/next?after=${S2}`)).status, 200, 'all done: nothing left, and no skip');
  });
  assert.deepEqual(lines, [
    { event: 'product', action: 'skip', front: 'quiz' },
    { event: 'product', action: 'way', front: 'quiz', outcome: 'new' },
    { event: 'product', action: 'way', front: 'quiz', outcome: 'found-too' }
  ]);
});
