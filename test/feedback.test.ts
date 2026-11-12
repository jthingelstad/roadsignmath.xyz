import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import type { Player } from '../src/domain/types.ts';
import { feedbackMail } from '../src/feedback.ts';
import { MemoryMailer, type Mail } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

/** A player who signed in but hasn't given a name yet. */
const nameless: Player = {
  id: '01JNNNNNNNNNNNNNNNNNNNNNNN',
  handle: 'p0123456789',
  name: '',
  avatarColor: '#18201C',
  email: 'nameless@example.com',
  createdAt: '2026-01-06T00:00:00.000Z'
};

class BrokenMailer extends MemoryMailer {
  override async send(_mail: Mail): Promise<void> {
    throw new Error('SES said no');
  }
}

async function setup(options: { mailer?: MemoryMailer; feedbackTo?: string | null } = {}) {
  const store = new MemoryStore();
  const mailer = options.mailer ?? new MemoryMailer();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    ...(options.feedbackTo === null ? {} : { feedbackTo: options.feedbackTo ?? 'feedback@example.test' })
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben, nameless]) {
    await addPlayer(store, player);
    const secret = player.id.toLowerCase().padEnd(43, 'x');
    await store.putSession({
      playerId: player.id,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: new Date().toISOString(),
      expiresAt: nowSeconds() + 3600
    });
    tokens[player.handle] = `rsm_${player.id}_${secret}`;
  }
  await addSign(store, sign({ id: '01JS0000000000000000000001', title: 'Exit Seven' }));
  await addSign(store, sign({ id: '01JS0000000000000000000002', title: 'Mile Twelve' }));
  const send = async (body: unknown, as: string | null = 'ada') => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) headers.authorization = `Bearer ${tokens[as]}`;
    const res = await app.request('/api/v1/feedback', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    return { res, body: (await res.json()) as Json };
  };
  return { store, mailer, send };
}

test('feedback is emailed with who sent it and from what, and no email address', async () => {
  const { mailer, send } = await setup();
  const { res, body } = await send({
    message: '  Love the map.\r\nThe Post button hid behind the keyboard once.  ',
    app: '0.9.0 (31) · iOS 26.1'
  });
  assert.equal(res.status, 202);
  assert.deepEqual(body, { sent: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(mailer.sent.length, 1);
  const [mail] = mailer.sent;
  assert.equal(mail.to, 'feedback@example.test');
  assert.equal(mail.subject, 'Road Sign Math feedback from Ada');
  assert.equal(mail.replyTo, undefined);
  assert.equal(mail.html, undefined);
  const lines = mail.text.split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    'Love the map.',
    'The Post button hid behind the keyboard once.',
    '',
    '—',
    'From: Ada (@ada)',
    'Page: https://example.test/players/ada',
    'Signs: 2',
    'App: 0.9.0 (31) · iOS 26.1',
    lines[8]
  ]);
  assert.match(lines[8], /^Sent: [A-Z][a-z]{2} \d{1,2}, 20\d\d, \d{1,2}:\d\d [AP]M C[DS]T$/);
  assert.equal(lines[9], 'Reply: not asked for. Their email address isn’t in this message.');
  assert.ok(!mail.text.includes('ada@example.com'));
});

test('with reply_ok the address goes only as the Reply-To', async () => {
  const { mailer, send } = await setup();
  assert.equal((await send({ message: 'Write back?', reply_ok: true })).res.status, 202);
  const [mail] = mailer.sent;
  assert.equal(mail.replyTo, 'ada@example.com');
  assert.ok(!mail.text.includes('ada@example.com'));
  assert.match(mail.text, /^App: not given$/m);
  assert.match(mail.text, /^Reply: fine\. Replying to this email goes to them\.$/m);
  await send({ message: 'No reply needed', reply_ok: false });
  assert.equal(mailer.sent[1].replyTo, undefined);
});

test('a player with no name yet is "a player" and has no page', async () => {
  const { mailer, send } = await setup();
  assert.equal((await send({ message: 'Hi' }, 'p0123456789')).res.status, 202);
  const [mail] = mailer.sent;
  assert.equal(mail.subject, 'Road Sign Math feedback from a player');
  assert.match(mail.text, /^From: a player with no name yet \(@p0123456789\)$/m);
  assert.doesNotMatch(mail.text, /^Page:/m);
  assert.match(mail.text, /^Signs: 0$/m);
});

test('the time is US Central', () => {
  const mail = feedbackMail(
    'feedback@example.test',
    { site: 'https://example.test' },
    ben,
    1,
    { message: 'Hi', replyOk: false },
    new Date('2026-07-04T17:30:00Z')
  );
  assert.match(mail.text, /^Sent: Jul 4, 2026, 12:30 PM CDT$/m);
  const winter = feedbackMail(
    'f@example.test',
    { site: 'https://example.test' },
    ben,
    1,
    { message: 'Hi', replyOk: false },
    new Date('2026-01-15T03:05:00Z')
  );
  assert.match(winter.text, /^Sent: Jan 14, 2026, 9:05 PM CST$/m);
});

test('a bad body is a 400 and sends nothing', async () => {
  const { mailer, send } = await setup();
  const bad: unknown[] = [
    {},
    { message: '' },
    { message: '   \n ' },
    { message: 7 },
    { message: 'x'.repeat(LIMITS.feedbackMax + 1) },
    { message: 'Hi', reply_ok: 'yes' },
    { message: 'Hi', app: 'x'.repeat(LIMITS.feedbackAppMax + 1) },
    { message: 'Hi', app: 31 },
    { message: 'Hi', email: 'someone@example.com' },
    { message: 'Bell\u0007' },
    [],
    'not json'
  ];
  for (const body of bad) {
    const { res, body: answer } = await send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(answer.error.code, 'bad_request');
  }
  assert.equal(mailer.sent.length, 0);
  assert.equal((await send({ message: 'x'.repeat(LIMITS.feedbackMax) })).res.status, 202);
  assert.equal((await send({ message: 'Hi', reply_ok: null, app: null })).res.status, 202);
});

test('signed out is a 401', async () => {
  const { mailer, send } = await setup();
  const { res, body } = await send({ message: 'Hi' }, null);
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'unauthorized');
  assert.equal(mailer.sent.length, 0);
});

test(`at most ${LIMITS.feedbackADay} a day per player`, async () => {
  const { mailer, send } = await setup();
  for (let i = 0; i < LIMITS.feedbackADay; i++) assert.equal((await send({ message: `Note ${i}` })).res.status, 202);
  const over = await send({ message: 'One more' });
  assert.equal(over.res.status, 429);
  assert.equal(over.body.error.code, 'rate_limited');
  assert.equal(mailer.sent.length, LIMITS.feedbackADay);
  // Another player's ten are their own.
  assert.equal((await send({ message: 'Mine' }, 'ben')).res.status, 202);
});

test('mail that can’t be sent is a 503', async () => {
  const { send } = await setup({ mailer: new BrokenMailer() });
  const error = console.error;
  const logged: unknown[] = [];
  console.error = (entry: unknown) => void logged.push(entry);
  try {
    const { res, body } = await send({ message: 'Hello?', reply_ok: true });
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'unavailable');
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, [{ event: 'feedback', outcome: 'unsent', detail: 'SES said no' }]);
});

test('without an address to send to, feedback is a 503', async () => {
  const { mailer, send } = await setup({ feedbackTo: null });
  const { res, body } = await send({ message: 'Hello?' });
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'unavailable');
  assert.equal(mailer.sent.length, 0);
});
