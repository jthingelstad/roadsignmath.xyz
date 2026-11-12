// A profile's website and home, the moderator's look at changed profile words, a report of a
// player, and taking yourself off a sign's finders. Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import { readWebsite } from '../src/auth/account.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MODERATOR_CALLS } from '../src/posting/posting.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

const SITE = 'https://example.test';
const S1 = '01JS0000000000000000000001';
const S2 = '01JS0000000000000000000002';

/** A player with an address, to show it never reaches a report's email. */
const cara: Player = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  handle: 'cara',
  name: 'Cara',
  avatarColor: '#004C80',
  email: 'cara@example.com',
  createdAt: '2026-01-03T00:00:00.000Z'
};

const nameless: Player = {
  id: '01JNNNNNNNNNNNNNNNNNNNNNNN',
  handle: 'pnameless00',
  name: '',
  avatarColor: '#B01C33',
  createdAt: '2026-01-04T00:00:00.000Z'
};

async function setup() {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator,
    clientIp: () => '192.0.2.1',
    feedbackTo: 'owner@example.test'
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben, cara, nameless]) {
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
  // Ada posted S1 and credits Ben with her; Ben posted S2 alone.
  await store.putSign(
    sign({
      id: S1,
      title: 'Seven Twelve',
      finders: [
        { playerId: ada.id, name: ada.name, role: 'found' },
        { playerId: ben.id, name: ben.name, role: 'found' }
      ]
    })
  );
  await store.putWay(way(S1));
  await store.putSign(
    sign({
      id: S2,
      title: 'Mile Nine',
      postedBy: ben.id,
      finders: [{ playerId: ben.id, name: ben.name, role: 'found' }]
    })
  );
  const call = async (method: string, path: string, as?: string, body?: unknown, raw?: Buffer) => {
    const headers: Record<string, string> = {};
    if (as) headers.authorization = `Bearer ${tokens[as]}`;
    if (raw) headers['content-type'] = 'image/jpeg';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path.startsWith('/') && !path.startsWith('/players.json') ? `/api/v1${path}` : path, {
      method,
      headers,
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { res, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as Json };
  };
  const page = async (path: string) => (await app.request(path)).text();
  return { store, mailer, moderator, call, page };
}

/** Runs `work` with what it logs caught. */
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
  return logged.filter((e) => typeof e === 'object' && e !== null && 'event' in e) as Json[];
}

// ---- The website, read

test('a website is an http or https address, kept normalised', () => {
  assert.equal(readWebsite('example.com'), 'https://example.com/', 'no scheme gets https');
  assert.equal(readWebsite('  Example.COM/Path?q=1  '), 'https://example.com/Path?q=1', 'trimmed, host in lower case');
  assert.equal(readWebsite('http://example.com'), 'http://example.com/');
  assert.equal(readWebsite('HTTPS://www.example.com/a'), 'https://www.example.com/a');
  assert.equal(readWebsite('example.com:8080/x'), 'https://example.com:8080/x', 'a port is not a scheme');
  assert.equal(readWebsite('bücher.example'), 'https://xn--bcher-kva.example/', 'an IDN host is kept as punycode');
  assert.equal(readWebsite('https://xn--bcher-kva.example'), 'https://xn--bcher-kva.example/');
  assert.equal(readWebsite('ex​ample.com'), 'https://example.com/', 'an invisible character is dropped');
  assert.equal(readWebsite(''), null, 'empty clears');
  assert.equal(readWebsite('   '), null, 'blank clears');
  assert.equal(readWebsite(null), null);
});

test('a website that isn’t a plain web address is refused, saying why', () => {
  const refused = (raw: unknown, message: RegExp) =>
    assert.throws(
      () => readWebsite(raw),
      (err: Error) => message.test(err.message),
      String(raw)
    );
  for (const raw of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<b>hi</b>',
    'ftp://example.com',
    'mailto:me@example.com',
    'file:///etc/passwd',
    'vbscript:x'
  ]) {
    refused(raw, /http or https/);
  }
  refused('https://me:secret@example.com', /user name or password/);
  refused('https://me@example.com', /user name or password/);
  refused('example.com@evil.example', /user name or password/);
  refused('my site.com', /spaces/);
  refused('example.com/a\tb', /spaces/);
  refused('example.com‮', /direction|control|invisible|character/i);
  refused('example.com\u0007', /control/);
  refused('localhost', /web address/);
  refused('localhost:3000', /web address/);
  refused('http://192.168.1.1', /web address/);
  refused('http://[::1]/', /web address/);
  refused('https://example.com.', /web address/);
  refused('https://', /web address/);
  refused(`example.com/${'a'.repeat(LIMITS.reportMax)}`, /at most 200 characters/);
  refused(`https://example.com/${'a'.repeat(185)}`, /at most 200 characters/);
  refused(42, /must be text/);
});

// ---- On the profile

test('a website and a home go on PATCH /me, show everywhere a bio does, and clear with null or empty', async () => {
  const t = await setup();
  const set = await t.call('PATCH', '/me', 'ada', { website: 'ada.example.com/signs', home: '  Testville,   MN ' });
  assert.equal(set.res.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.website, 'https://ada.example.com/signs');
  assert.equal(set.body.home, 'Testville, MN');
  assert.deepEqual(
    t.moderator.profiles,
    [{ website: 'https://ada.example.com/signs', home: 'Testville, MN' }],
    'one look, at both'
  );
  const me = (await t.call('GET', '/me', 'ada')).body;
  assert.equal(me.website, 'https://ada.example.com/signs');
  const player = (await t.call('GET', '/players/ada')).body;
  assert.equal(player.website, 'https://ada.example.com/signs');
  assert.equal(player.home, 'Testville, MN');
  const list = (await t.call('GET', '/players')).body.players.find((p: Json) => p.handle === 'ada');
  assert.equal(list.home, 'Testville, MN');
  const open = (await t.call('GET', '/players.json')).body.players.find((p: Json) => p.handle === 'ada');
  assert.equal(open.website, 'https://ada.example.com/signs');
  assert.equal(open.home, 'Testville, MN');
  assert.equal((await t.call('GET', '/players/ben')).body.website, null, 'null when there is none');

  const html = await t.page('/players/ada');
  assert.ok(html.includes('<a href="https://ada.example.com/signs" rel="nofollow ugc noopener">ada.example.com</a>'));
  assert.ok(html.includes('Testville, MN'));

  const cleared = await t.call('PATCH', '/me', 'ada', { website: null, home: '' });
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.body.website, null);
  assert.equal(cleared.body.home, null);
  assert.equal(t.moderator.profiles.length, 1, 'taking words away needs no look');
  const kept = (await t.store.getPlayer(ada.id))!;
  assert.ok(!('website' in kept) && !('home' in kept), 'removed from the row');
});

test('a host shows without its www', async () => {
  const t = await setup();
  await t.call('PATCH', '/me', 'ada', { website: 'https://www.ada.example.com' });
  assert.ok((await t.page('/players/ada')).includes('>ada.example.com</a>'));
});

test('a home is short text with the name’s rules', async () => {
  const t = await setup();
  const long = await t.call('PATCH', '/me', 'ada', { home: 'x'.repeat(61) });
  assert.equal(long.res.status, 400);
  assert.equal(long.body.error.message, 'home is at most 60 characters');
  assert.equal((await t.call('PATCH', '/me', 'ada', { home: 'Test‮ville' })).res.status, 400);
  assert.equal((await t.call('PATCH', '/me', 'ada', { home: 7 })).res.status, 400);
  const unknown = await t.call('PATCH', '/me', 'ada', { town: 'Testville' });
  assert.equal(unknown.res.status, 400);
  assert.equal(unknown.body.error.message, 'Only name, bio, website and home can change, not town');
  assert.equal(t.moderator.profiles.length, 0, 'nothing refused for its form reaches the moderator');
});

test('a blocked player’s website and home show as their bio does', async () => {
  const t = await setup();
  await t.call('PATCH', '/me', 'ben', { website: 'ben.example.com', home: 'Elsewhere' });
  assert.equal((await t.call('POST', '/players/ben/block', 'ada')).res.status, 204);
  const seen = (await t.call('GET', '/players/ben', 'ada')).body;
  assert.equal(seen.bio, null);
  assert.equal(seen.website, 'https://ben.example.com/');
  assert.equal(seen.home, 'Elsewhere');
});

// ---- The moderator's look

test('only the changed words go to the moderator, together in one call', async () => {
  const t = await setup();
  const res = await t.call('PATCH', '/me', 'ada', { name: 'Ada', bio: 'Counts signs.', home: 'Testville' });
  assert.equal(res.res.status, 200);
  assert.deepEqual(t.moderator.profiles, [{ bio: 'Counts signs.', home: 'Testville' }], 'the name didn’t change');
  assert.equal((await t.call('PATCH', '/me', 'ada', { bio: 'Counts signs.' })).res.status, 200);
  assert.equal(t.moderator.profiles.length, 1, 'the same again is no change and no look');
});

test('words the moderator won’t show are a 422 with its sentence, and nothing is saved', async () => {
  const t = await setup();
  t.moderator.profile = { verdict: 'hold', reason: 'That website is an advertisement.' };
  const refused = await t.call('PATCH', '/me', 'ada', { bio: 'New bio', website: 'shop.example.com' });
  assert.equal(refused.res.status, 422);
  assert.deepEqual(refused.body.error, { code: 'refused', message: 'That website is an advertisement.' });
  const kept = (await t.store.getPlayer(ada.id))!;
  assert.equal(kept.bio, ada.bio, 'not even the bio');
  assert.equal(kept.website, undefined);

  t.moderator.profile = { verdict: 'hold', reason: '' };
  const plain = await t.call('PATCH', '/me', 'ada', { home: 'Somewhere' });
  assert.equal(plain.body.error.message, 'Our moderator wouldn’t show that on your profile.');
});

test('an unavailable moderator is a 503 and nothing is saved', async () => {
  const t = await setup();
  t.moderator.profile = 'unavailable';
  let res: Awaited<ReturnType<typeof t.call>> | undefined;
  const events = await catching(async () => {
    res = await t.call('PATCH', '/me', 'ada', { name: 'Ada Lovelace' });
  });
  assert.equal(res!.res.status, 503);
  assert.equal(res!.body.error.code, 'unavailable');
  assert.equal((await t.store.getPlayer(ada.id))!.name, 'Ada');
  assert.ok(events.some((e) => e.event === 'moderator' && e.outcome === 'unavailable' && e.op === 'profile'));
});

test('a profile look counts against the day’s ceiling, and past it is the busy 503', async () => {
  const t = await setup();
  const now = nowSeconds();
  for (let i = 0; i < LIMITS.moderatorCallsADay - 1; i++) await t.store.bump(MODERATOR_CALLS, 86400, now);
  assert.equal((await t.call('PATCH', '/me', 'ada', { home: 'Testville' })).res.status, 200, 'the last call');
  const past = await t.call('PATCH', '/me', 'ada', { home: 'Elsewhere' });
  assert.equal(past.res.status, 503);
  assert.equal(past.body.error.message, 'Our moderator is busy today. Try again tomorrow.');
  assert.equal(t.moderator.profiles.length, 1, 'not asked past the ceiling');
  assert.equal((await t.store.getPlayer(ada.id))!.home, 'Testville');
  assert.equal((await t.call('PATCH', '/me', 'ada', { home: null })).res.status, 200, 'clearing needs no look');
});

test('the day’s profile limit applies before the moderator is asked', async () => {
  const t = await setup();
  for (let i = 0; i < LIMITS.profileEditsADay; i++) {
    assert.equal((await t.call('PATCH', '/me', 'ada', { home: `Town ${i}` })).res.status, 200);
  }
  const looks = t.moderator.profiles.length;
  const over = await t.call('PATCH', '/me', 'ada', { home: 'One more' });
  assert.equal(over.res.status, 429);
  assert.equal(t.moderator.profiles.length, looks, 'no look once the day is used up');
});

test('the first name goes through the same look, and a refused one leaves the player unnamed', async () => {
  const t = await setup();
  t.moderator.profile = { verdict: 'hold', reason: 'That name is a slur.' };
  const refused = await t.call('PATCH', '/me', 'pnameless00', { name: 'Bad Word' });
  assert.equal(refused.res.status, 422);
  assert.equal(refused.body.error.message, 'That name is a slur.');
  const still = (await t.call('GET', '/me', 'pnameless00')).body;
  assert.equal(still.needs_name, true);
  assert.equal(still.handle, 'pnameless00', 'no handle taken');
  t.moderator.profile = { verdict: 'ok', reason: '' };
  const named = await t.call('PATCH', '/me', 'pnameless00', { name: 'Pat' });
  assert.equal(named.res.status, 200);
  assert.equal(named.body.handle, 'pat');
  assert.deepEqual(t.moderator.profiles, [{ name: 'Bad Word' }, { name: 'Pat' }]);
});

test('a post’s moderation sees its place and its finders’ names', async () => {
  const t = await setup();
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#f2b300' } })
    .jpeg()
    .toBuffer();
  const upload = await t.call('POST', '/photos', 'ada', undefined, jpeg);
  const posted = await t.call('POST', '/signs', 'ada', {
    photo_ids: [upload.body.id],
    title: 'Exit 7',
    numbers: [{ value: '7' }, { value: '12' }, { value: '19' }],
    place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
    found_on: '2026-06-01',
    way: '7 + 12 = 19'
  });
  assert.equal(posted.res.status, 201, JSON.stringify(posted.body));
  assert.equal(t.moderator.posts[0].place, 'Testville, Minnesota');
  assert.deepEqual(t.moderator.posts[0].finders, ['Ada']);
  assert.equal((await t.call('POST', `/signs/${S1}/report`, 'cara', { reason: 'Spam' })).res.status, 200);
  assert.equal(t.moderator.reports[0].post.place, 'Testville, Minnesota');
  assert.deepEqual(t.moderator.reports[0].post.finders, ['Ada', 'Ben']);
});

// ---- Reporting a player

test('a player report is kept once, emailed to the owner without an address, and hides nothing', async () => {
  const t = await setup();
  let res: Awaited<ReturnType<typeof t.call>> | undefined;
  const events = await catching(async () => {
    res = await t.call('POST', '/players/ada/report', 'cara', { reason: '  Rude   bio ' });
  });
  assert.equal(res!.res.status, 200);
  assert.deepEqual(res!.body, { received: true });
  const kept = (await t.store.getPlayerReport(ada.id, cara.id))!;
  assert.equal(kept.reason, 'Rude bio');
  assert.equal(t.mailer.sent.length, 1);
  const mail = t.mailer.sent[0];
  assert.equal(mail.to, 'owner@example.test');
  assert.equal(mail.subject, 'Road Sign Math player report: Ada');
  assert.ok(mail.text.includes('Cara (@cara) reported the player Ada (@ada).'), mail.text);
  assert.ok(mail.text.includes(`${SITE}/players/ada`));
  assert.ok(mail.text.includes('Reason: Rude bio'));
  assert.ok(mail.text.includes('Claude doesn’t look at it, and nothing is hidden.'));
  for (const address of ['cara@example.com', 'ada@example.com']) assert.ok(!mail.text.includes(address), address);
  assert.equal(mail.replyTo, undefined);
  assert.equal(t.moderator.reports.length + t.moderator.profiles.length, 0, 'no moderator');
  assert.ok(events.some((e) => e.event === 'report-mail' && e.kind === 'player' && e.outcome === 'sent'));
  assert.ok(!JSON.stringify(events).includes('@example'), 'no address logged');
  assert.equal((await t.call('GET', '/players/ada')).res.status, 200, 'still shown');

  const again = await t.call('POST', '/players/ada/report', 'cara', { reason: 'Still rude' });
  assert.equal(again.res.status, 200);
  assert.equal(t.mailer.sent.length, 1, 'a repeat sends nothing');
  assert.equal((await t.store.getPlayerReport(ada.id, cara.id))!.reason, 'Rude bio', 'and changes nothing');
});

test('no reporting yourself, a missing reason, an unknown player or too many a day', async () => {
  const t = await setup();
  const self = await t.call('POST', '/players/cara/report', 'cara', { reason: 'Me' });
  assert.equal(self.res.status, 400);
  assert.equal(self.body.error.message, 'You can’t report yourself');
  assert.equal((await t.call('POST', '/players/ada/report', 'cara', { reason: '' })).res.status, 400);
  const long = await t.call('POST', '/players/ada/report', 'cara', { reason: 'x'.repeat(LIMITS.reportMax + 1) });
  assert.equal(long.res.status, 400);
  assert.equal((await t.call('POST', '/players/ada/report', 'cara', { reason: 'x', why: 'y' })).res.status, 400);
  assert.equal((await t.call('POST', '/players/nobody/report', 'cara', { reason: 'x' })).res.status, 404);
  assert.equal((await t.call('POST', '/players/ada/report', undefined, { reason: 'x' })).res.status, 401);
  // Sign reports and player reports share the day's count.
  const now = nowSeconds();
  for (let i = 0; i < LIMITS.reportsADay; i++) await t.store.bump(`reports:${cara.id}`, 86400, now);
  const over = await t.call('POST', '/players/ada/report', 'cara', { reason: 'Rude' });
  assert.equal(over.res.status, 429);
  assert.equal(t.mailer.sent.length, 0);
});

test('deleting an account removes its reports of others and others’ reports of it', async () => {
  const t = await setup();
  await t.call('POST', '/players/ada/report', 'cara', { reason: 'Rude' });
  await t.call('POST', '/players/cara/report', 'ben', { reason: 'Rude too' });
  assert.equal((await t.call('DELETE', '/me', 'cara')).res.status, 204);
  assert.equal(await t.store.getPlayerReport(ada.id, cara.id), undefined, 'hers of Ada');
  assert.equal(await t.store.getPlayerReport(cara.id, ben.id), undefined, 'Ben’s of her');
});

// ---- Taking yourself off a sign

test('a credited finder takes themselves off a sign someone else posted; their ways stay', async () => {
  const t = await setup();
  await t.store.putWay(way(S1, { id: 'w-ben', playerId: ben.id, text: '19 − 12 = 7', value: '7' }));
  const left = await t.call('DELETE', `/signs/${S1}/finders/me`, 'ben');
  assert.equal(left.res.status, 204);
  const s = (await t.store.getSign(S1))!;
  assert.deepEqual(
    s.finders.map((f) => f.playerId),
    [ada.id]
  );
  assert.ok(
    (await t.store.listWays(S1)).some((w) => w.id === 'w-ben'),
    'his way stays'
  );
  const again = await t.call('DELETE', `/signs/seven-twelve/finders/me`, 'ben');
  assert.equal(again.res.status, 204, 'not credited: nothing to do');
  assert.equal((await t.store.getSign(S1))!.finders.length, 1);
});

test('the poster can’t take themselves off; an only finder is replaced by the poster', async () => {
  const t = await setup();
  const poster = await t.call('DELETE', `/signs/${S1}/finders/me`, 'ada');
  assert.equal(poster.res.status, 400);
  assert.equal(poster.body.error.message, 'You posted this sign. Delete it instead');
  // A sign Ada posted crediting only Cara.
  await t.store.updateSign(S1, { finders: [{ playerId: cara.id, name: cara.name, role: 'found' }] });
  assert.equal((await t.call('DELETE', `/signs/${S1}/finders/me`, 'cara')).res.status, 204);
  assert.deepEqual((await t.store.getSign(S1))!.finders, [{ playerId: ada.id, name: 'Ada', role: 'found' }]);
  assert.equal((await t.call('DELETE', `/signs/NOPE/finders/me`, 'cara')).res.status, 404);
  assert.equal((await t.call('DELETE', `/signs/${S1}/finders/me`)).res.status, 401);
});

test('a finder can leave a sign whose poster they blocked', async () => {
  const t = await setup();
  await t.call('POST', '/players/ada/block', 'ben');
  assert.equal((await t.call('DELETE', `/signs/${S1}/finders/me`, 'ben')).res.status, 204);
  assert.ok(!(await t.store.getSign(S1))!.finders.some((f) => f.playerId === ben.id));
});
