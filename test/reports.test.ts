import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer, type Mail } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

/** A reporter with an address, to show it never reaches the email. */
const cara: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cara',
  name: 'Cara',
  avatarColor: '#004C80',
  email: 'cara@example.com',
  createdAt: '2026-01-03T00:00:00.000Z'
};

class BrokenMailer extends MemoryMailer {
  override async send(_mail: Mail): Promise<void> {
    throw new Error('SES said no');
  }
}

async function setup(options: { mailer?: MemoryMailer; feedbackTo?: string | null } = {}) {
  const store = new MemoryStore();
  const mailer = options.mailer ?? new MemoryMailer();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator,
    clientIp: () => '192.0.2.1',
    ...(options.feedbackTo === null ? {} : { feedbackTo: options.feedbackTo ?? 'feedback@example.test' })
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben, cara]) {
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
  const call = async (path: string, body: unknown, as = 'cara') => {
    const res = await app.request(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[as]}` },
      body: JSON.stringify(body)
    });
    return { res, body: (await res.json()) as Json };
  };
  return { store, mailer, moderator, call };
}

const noAddress = (mail: Mail) => {
  for (const address of ['cara@example.com', 'ada@example.com']) assert.ok(!mail.text.includes(address), address);
  assert.equal(mail.replyTo, undefined);
};

test('a report Claude upholds emails Jamie the sign, its link, the reason, the verdict and who reported it', async () => {
  const { mailer, moderator, call } = await setup();
  moderator.report = { verdict: 'hide', reason: 'It is an advertisement.' };
  const { res, body } = await call('/signs/exit-seven/report', { reason: 'Spam, not a sign' });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { outcome: 'hidden', note: 'It is an advertisement.' });
  assert.equal(mailer.sent.length, 1);
  const [mail] = mailer.sent;
  assert.equal(mail.to, 'feedback@example.test');
  assert.equal(mail.subject, 'Road Sign Math report: Exit Seven (hidden)');
  const lines = mail.text.split('\n');
  assert.deepEqual(lines.slice(0, 10), [
    'Cara (@cara) reported “Exit Seven”.',
    'https://example.test/signs/exit-seven',
    '',
    'Reason: Spam, not a sign',
    '',
    'Claude hid it.',
    'Claude’s note: It is an advertisement.',
    '',
    '—',
    'Sign: exit-seven, posted by Ada (@ada), now hidden'
  ]);
  assert.match(lines[10], /^Sent: [A-Z][a-z]{2} \d{1,2}, 20\d\d, \d{1,2}:\d\d [AP]M C[DS]T$/);
  assert.ok(mail.text.includes('npm run owner -- hide-sign exit-seven --to check'));
  noAddress(mail);
});

test('a kept report is emailed as kept, once: asking again sends nothing new', async () => {
  const { mailer, call } = await setup();
  assert.equal((await call('/signs/exit-seven/report', { reason: 'I don’t like it' })).res.status, 200);
  assert.equal((await call('/signs/exit-seven/report', { reason: 'Still don’t' })).res.status, 200);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, 'Road Sign Math report: Exit Seven (kept)');
  assert.match(mailer.sent[0].text, /^Claude kept it\.$/m);
  assert.match(mailer.sent[0].text, /^Sign: exit-seven, posted by Ada \(@ada\), now shown$/m);
  noAddress(mailer.sent[0]);
});

test('a mail that fails changes nothing about the report, and none goes without FEEDBACK_TO', async () => {
  const broken = await setup({ mailer: new BrokenMailer() });
  broken.moderator.report = { verdict: 'hide', reason: 'Not a road sign.' };
  const sent = await broken.call('/signs/exit-seven/report', { reason: 'Spam' });
  assert.equal(sent.res.status, 200);
  assert.equal(sent.body.outcome, 'hidden');
  assert.equal((await broken.store.getSign('01JS0000000000000000000001'))?.visibility, 'hidden');
  assert.equal((await broken.store.getReport('01JS0000000000000000000001', cara.id))?.outcome, 'hidden');

  const off = await setup({ feedbackTo: null });
  assert.equal((await off.call('/signs/exit-seven/report', { reason: 'Spam' })).res.status, 200);
  assert.equal(off.mailer.sent.length, 0);
});

test('a report the moderator can’t answer sends no email', async () => {
  const { mailer, moderator, call } = await setup();
  moderator.report = 'unavailable';
  assert.equal((await call('/signs/exit-seven/report', { reason: 'Spam' })).res.status, 503);
  assert.equal(mailer.sent.length, 0);
});

test('a duplicate report is emailed too, labelled as a duplicate', async () => {
  const { mailer, call } = await setup();
  const { res } = await call('/signs/exit-seven/duplicate', { same_as: 'mile-twelve', note: 'Same exit, other side' });
  assert.equal(res.status, 200);
  assert.equal(mailer.sent.length, 1);
  const [mail] = mailer.sent;
  assert.equal(mail.to, 'feedback@example.test');
  assert.equal(mail.subject, 'Road Sign Math duplicate: Exit Seven');
  assert.deepEqual(mail.text.split('\n').slice(0, 5), [
    'Cara (@cara) says “Exit Seven” is a duplicate of “Mile Twelve”.',
    'This one: https://example.test/signs/exit-seven',
    'Same as: https://example.test/signs/mile-twelve',
    '',
    'Note: Same exit, other side'
  ]);
  noAddress(mail);

  // The same report again sends nothing; a changed one is mailed.
  const again = await call('/signs/exit-seven/duplicate', { same_as: 'mile-twelve', note: 'Same exit, other side' });
  assert.equal(again.res.status, 200);
  assert.deepEqual(again.body, { same_as: 'mile-twelve', note: 'Same exit, other side' });
  assert.equal(mailer.sent.length, 1);
  await call('/signs/exit-seven/duplicate', { same_as: 'mile-twelve', note: 'Same exit, I’m sure' });
  assert.equal(mailer.sent.length, 2);

  // Without a note, it says so; a failing mailer leaves the report kept.
  const broken = await setup({ mailer: new BrokenMailer() });
  const kept = await broken.call('/signs/exit-seven/duplicate', { same_as: 'mile-twelve' });
  assert.equal(kept.res.status, 200);
  assert.ok(await broken.store.getDuplicate('01JS0000000000000000000001', cara.id));
});
