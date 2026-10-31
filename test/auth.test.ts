import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { LIMITS, MAX_CODE_ATTEMPTS, network } from '../src/auth/auth.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { addPlayer } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

// oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
type Json = Record<string, any>;

function setup(store = new MemoryStore()) {
  const mailer = new MemoryMailer();
  let ip = '192.0.2.1';
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => ip
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { res, body: (text ? JSON.parse(text) : null) as Json };
  };
  const lastMail = () => {
    const mail = mailer.sent.at(-1)!;
    const code = /code is (\d{6})/.exec(mail.subject)![1];
    const link = new URL(/https:\/\/\S+/.exec(mail.text)![0]);
    return { mail, code, loginId: link.searchParams.get('l')!, token: link.searchParams.get('t')!, link };
  };
  return { store, mailer, call, lastMail, setIp: (next: string) => (ip = next) };
}

async function signIn(t: ReturnType<typeof setup>, email: string) {
  const started = await t.call('POST', '/auth/start', { email });
  const { code } = t.lastMail();
  const done = await t.call('POST', '/auth/verify', { login_id: started.body.login_id, code });
  return done.body as Json;
}

test('the email has a link to the app and a code, and says how long they last', async () => {
  const t = setup();
  const { res, body } = await t.call('POST', '/auth/start', { email: ' New.Player@Example.com ' });
  assert.equal(res.status, 202);
  assert.equal(body.expires_in, 900);
  const { mail, link, loginId } = t.lastMail();
  assert.equal(mail.to, 'new.player@example.com');
  assert.equal(link.origin + link.pathname, 'https://example.test/signin');
  assert.equal(loginId, body.login_id);
  assert.match(mail.text, /15 minutes/);
  assert.ok(mail.html?.includes(`href="${link.href.replaceAll('&', '&amp;')}"`), 'the HTML part has the link');
  assert.ok(mail.html?.includes(`>${/code is (\d{6})/.exec(mail.subject)![1]}</td>`), 'and the code');
});

test('the first sign-in makes a player with no name yet; the token works until sign-out', async () => {
  const t = setup();
  const done = await signIn(t, 'new@example.com');
  assert.equal(done.new_player, true);
  assert.match(done.token, /^rsm_[0-9A-Z]{26}_[\w-]{43}$/);
  assert.equal(done.me.email, 'new@example.com');
  assert.equal(done.me.needs_name, true);
  assert.match(done.me.handle, /^p[0-9a-f]{10}$/);

  const me = await t.call('GET', '/me', undefined, done.token);
  assert.equal(me.res.status, 200);
  assert.equal(me.res.headers.get('Cache-Control'), 'no-store');
  assert.equal((await t.call('POST', '/auth/signout', undefined, done.token)).res.status, 204);
  const after = await t.call('GET', '/me', undefined, done.token);
  assert.equal(after.res.status, 401);
  assert.equal(after.body.error.code, 'unauthorized');
});

test('signing in again with the same address finds the same player', async () => {
  const t = setup();
  const first = await signIn(t, 'same@example.com');
  const second = await signIn(t, 'SAME@example.com');
  assert.equal(second.new_player, false);
  assert.equal(second.me.handle, first.me.handle);
  assert.notEqual(second.token, first.token);
});

test('the link token signs in too, once', async () => {
  const t = setup();
  await t.call('POST', '/auth/start', { email: 'link@example.com' });
  const { loginId, token } = t.lastMail();
  assert.equal((await t.call('POST', '/auth/verify', { login_id: loginId, token })).res.status, 200);
  assert.equal((await t.call('POST', '/auth/verify', { login_id: loginId, token })).res.status, 401);
});

test('five wrong codes end the sign-in, even if the right one comes next', async () => {
  const t = setup();
  await t.call('POST', '/auth/start', { email: 'guess@example.com' });
  const { loginId, code } = t.lastMail();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 1; i <= MAX_CODE_ATTEMPTS; i++) {
    const { res, body } = await t.call('POST', '/auth/verify', { login_id: loginId, code: wrong });
    assert.equal(res.status, 401);
    assert.match(body.error.message, i < MAX_CODE_ATTEMPTS ? /isn't right/ : /Too many wrong codes/);
  }
  assert.equal((await t.call('POST', '/auth/verify', { login_id: loginId, code })).res.status, 401);
});

test('a sign-in ends after 15 minutes', async () => {
  const t = setup();
  await t.call('POST', '/auth/start', { email: 'slow@example.com' });
  const { loginId, code } = t.lastMail();
  const login = (await t.store.getLogin(loginId))!;
  await t.store.putLogin({ ...login, expiresAt: login.expiresAt - 901 });
  const { res, body } = await t.call('POST', '/auth/verify', { login_id: loginId, code });
  assert.equal(res.status, 401);
  assert.match(body.error.message, /ended/);
});

test('sign-in emails are limited per address and per network', async () => {
  const t = setup();
  for (let i = 0; i < LIMITS.address; i++) {
    assert.equal((await t.call('POST', '/auth/start', { email: 'busy@example.com' })).res.status, 202);
  }
  const over = await t.call('POST', '/auth/start', { email: 'busy@example.com' });
  assert.equal(over.res.status, 429);
  assert.equal(over.body.error.code, 'rate_limited');

  const n = setup();
  n.setIp('2001:db8:1:2:aaaa::1');
  for (let i = 0; i < LIMITS.network; i++) await n.call('POST', '/auth/start', { email: `p${i}@example.com` });
  n.setIp('2001:db8:1:2:bbbb::9');
  assert.equal((await n.call('POST', '/auth/start', { email: 'other@example.com' })).res.status, 429);
  n.setIp('192.0.2.50');
  assert.equal((await n.call('POST', '/auth/start', { email: 'other@example.com' })).res.status, 202);
});

test('bad input is a 400 that says what is wrong', async () => {
  const t = setup();
  const cases: [string, unknown, RegExp][] = [
    ['/auth/start', { email: 'not an email' }, /email/],
    ['/auth/start', ['x'], /JSON object/],
    ['/auth/verify', { code: '123456' }, /login_id/],
    ['/auth/verify', { login_id: 'x', code: '12', token: 'y' }, /either code or token/],
    ['/auth/verify', { login_id: 'x', code: '12' }, /six digits/]
  ];
  for (const [path, body, message] of cases) {
    const res = await t.call('POST', path, body);
    assert.equal(res.res.status, 400, JSON.stringify(body));
    assert.match(res.body.error.message, message);
  }
});

test('tokens are checked: none, malformed and made-up tokens are 401s', async () => {
  const t = setup();
  assert.equal((await t.call('GET', '/me')).res.status, 401);
  assert.equal((await t.call('GET', '/me', undefined, 'nonsense')).res.status, 401);
  const madeUp = `rsm_${'0'.repeat(26)}_${'a'.repeat(43)}`;
  assert.equal((await t.call('GET', '/me', undefined, madeUp)).res.status, 401);
  // A public read with a bad token says so rather than quietly ignoring it.
  assert.equal((await t.call('GET', '/signs', undefined, madeUp)).res.status, 401);
});

test('a public read with a token is not cached', async () => {
  const t = setup();
  const done = await signIn(t, 'reader@example.com');
  const { res } = await t.call('GET', '/signs', undefined, done.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('the first name sets the handle; later names keep it', async () => {
  const t = setup();
  await addPlayer(t.store, { ...ada, handle: 'ada-lovelace' });
  const done = await signIn(t, 'another.ada@example.com');
  const named = await t.call('PATCH', '/me', { name: '  Ada   Lovelace ', bio: 'Counts.' }, done.token);
  assert.equal(named.res.status, 200);
  assert.equal(named.body.name, 'Ada Lovelace');
  assert.equal(named.body.handle, 'ada-lovelace-2');
  assert.equal(named.body.needs_name, false);
  assert.equal(named.body.bio, 'Counts.');
  const renamed = await t.call('PATCH', '/me', { name: 'Ada L', bio: null }, done.token);
  assert.equal(renamed.body.handle, 'ada-lovelace-2');
  assert.equal(renamed.body.bio, null);
  for (const body of [{ name: '' }, { name: 'x'.repeat(41) }, { email: 'x@example.com' }, { bio: 7 }]) {
    assert.equal((await t.call('PATCH', '/me', body, done.token)).res.status, 400, JSON.stringify(body));
  }
});

test('deleting the account removes what it made and nothing else', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await addPlayer(store, ben);
  // Ada's own sign, with a way Ben found.
  await store.putSign(sign({ id: 'S1', title: 'Ada Posted' }));
  await store.putWay(way('S1', { id: 'w1', createdAt: '2026-01-01T00:00:00.000Z' }));
  await store.putWay(way('S1', { id: 'w2', playerId: ben.id, createdAt: '2026-01-02T00:00:00.000Z' }));
  // Ben's sign: Ada helped find it and found the first way; Ben found the second.
  await store.putSign(
    sign({
      id: 'S2',
      title: 'Ben Posted',
      postedBy: ben.id,
      finders: [
        { playerId: ben.id, name: ben.name, role: 'took_photo' },
        { playerId: ada.id, name: ada.name, role: 'spotted' }
      ],
      wayCount: 2
    })
  );
  await store.putWay(way('S2', { id: 'w3', createdAt: '2026-01-01T00:00:00.000Z' }));
  await store.putWay(
    way('S2', { id: 'w4', playerId: ben.id, text: '19 − 12 = 7', value: '7', createdAt: '2026-01-03T00:00:00.000Z' })
  );

  const t = setup(store);
  const done = await signIn(t, ada.email!);
  assert.equal(done.new_player, false);
  assert.equal((await t.call('DELETE', '/me', undefined, done.token)).res.status, 204);

  assert.equal(await store.getSign('S1'), undefined);
  assert.deepEqual(await store.listWays('S1'), []);
  const s2 = (await store.getSign('S2'))!;
  assert.deepEqual(
    s2.finders.map((f) => f.name),
    ['Ben']
  );
  assert.equal(s2.wayCount, 1);
  assert.deepEqual(s2.firstWay, { text: '19 − 12 = 7', value: '7', playerId: ben.id });
  assert.deepEqual(
    (await store.listWays('S2')).map((w) => w.id),
    ['w4']
  );
  assert.equal(await store.getPlayer(ada.id), undefined);
  assert.equal(await store.playerIdForEmail(ada.email!), undefined);
  assert.ok(await store.getPlayer(ben.id));
  assert.equal((await t.call('GET', '/me', undefined, done.token)).res.status, 401);
  // Signing in again with the address starts afresh.
  assert.equal((await signIn(t, ada.email!)).new_player, true);
});

test('two first sign-ins at once with one address make one player', async () => {
  const t = setup();
  await t.call('POST', '/auth/start', { email: 'twice@example.com' });
  const first = t.lastMail();
  await t.call('POST', '/auth/start', { email: 'twice@example.com' });
  const second = t.lastMail();
  const [a, b] = await Promise.all([
    t.call('POST', '/auth/verify', { login_id: first.loginId, code: first.code }),
    t.call('POST', '/auth/verify', { login_id: second.loginId, code: second.code })
  ]);
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(a.body.me.handle, b.body.me.handle);
  assert.deepEqual([a.body.new_player, b.body.new_player].sort(), [false, true]);
  assert.equal((await t.store.allPlayers()).length, 1);
});

test('one code signs in once, even when sent twice at once', async () => {
  const t = setup();
  await t.call('POST', '/auth/start', { email: 'race@example.com' });
  const { loginId, code } = t.lastMail();
  const answers = await Promise.all([
    t.call('POST', '/auth/verify', { login_id: loginId, code }),
    t.call('POST', '/auth/verify', { login_id: loginId, code })
  ]);
  assert.deepEqual(answers.map((a) => a.res.status).sort(), [200, 401]);
});

test('two players naming themselves the same at once get different handles', async () => {
  const t = setup();
  const one = await signIn(t, 'one@example.com');
  const two = await signIn(t, 'two@example.com');
  const [a, b] = await Promise.all([
    t.call('PATCH', '/me', { name: 'Same Name' }, one.token),
    t.call('PATCH', '/me', { name: 'Same Name' }, two.token)
  ]);
  assert.deepEqual([a.body.handle, b.body.handle].sort(), ['same-name', 'same-name-2']);
});

test("one player's two first names at once leave one handle, and the other name", async () => {
  const t = setup();
  const done = await signIn(t, 'quick@example.com');
  await Promise.all([
    t.call('PATCH', '/me', { name: 'First Try' }, done.token),
    t.call('PATCH', '/me', { name: 'Second Try' }, done.token)
  ]);
  const me = (await t.call('GET', '/me', undefined, done.token)).body;
  assert.ok(['first-try', 'second-try'].includes(me.handle), me.handle);
  // The handle the other request reserved is free again; the kept one and the random one are not.
  const other = me.handle === 'first-try' ? 'second-try' : 'first-try';
  assert.equal(await t.store.claimHandle(other, 'SOMEONE'), true);
  assert.equal(await t.store.claimHandle(me.handle, 'SOMEONE'), false);
});

test('networks: IPv4 as is, IPv6 by /64', () => {
  assert.equal(network('192.0.2.7'), '192.0.2.7');
  assert.equal(network('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(network('2001:db8::1'), '2001:db8::/64');
});
