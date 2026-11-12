// The website's signed-in side (src/web/account.tsx), shut as deployed and open as
// `siteSignInOpen` makes it: sign-in by code and by the email's link, the shared cookie and its
// marker, /you with held and hidden signs, deleting a sign and an account, and that the cached
// pages and the iPhone app's /signin landing stay as they were. Fictional players and signs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { markerOf } from '../src/quiz/session.ts';
import { SITE_SIGNIN_OPEN, WHO_SCRIPT, withSignIn } from '../src/web/account.tsx';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';
const S1 = '01JS0000000000000000000001';
const HELD = '01JS0000000000000000000003';
const BENS = '01JS0000000000000000000004';

async function setup(open: boolean | undefined) {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const photos = new MemoryPhotoStore();
  const newsletter = new MemoryNewsletter();
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer,
    photos,
    moderator: new ScriptedModerator(),
    newsletter,
    clientIp: () => '192.0.2.1',
    quizOpen: true,
    ...(open !== undefined && { siteSignInOpen: open })
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
  await store.putSign(
    sign({
      id: HELD,
      title: 'Held Junction',
      visibility: 'held',
      moderation: { note: 'A person will look at this one.', at: '2026-01-12T00:00:00.000Z' },
      postedAt: '2026-01-12T12:00:00.000Z'
    })
  );
  await store.putSign(sign({ id: BENS, title: 'Bens Hidden', visibility: 'hidden', postedBy: ben.id }));
  photos.files.set(`held/ph-${HELD}/thumb`, Buffer.from('held-thumb'));
  photos.files.set(`held/ph-${BENS}/thumb`, Buffer.from('bens-thumb'));

  const request = async (
    path: string,
    init: { form?: Record<string, string>; as?: string; cookie?: string; origin?: string | null; front?: 'quiz' } = {}
  ) => {
    const headers: Record<string, string> = {};
    if (init.front) headers['X-RSM-Front'] = init.front;
    const cookie = init.cookie ?? (init.as ? `rsm_session=${tokens[init.as]}` : undefined);
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
      if (init.origin !== null) headers.origin = init.origin ?? (init.front ? QUIZ : SITE);
    }
    const res = await app.request(path, { method: body !== undefined ? 'POST' : 'GET', headers, body });
    return { res, html: await res.text(), location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
  };
  return { app, store, mailer, photos, newsletter, request, tokens };
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
/** The cookie by that name a browser keeps: the last one set. */
const cookieNamed = (cookies: string[], name: string) => cookies.findLast((c) => c.startsWith(`${name}=`));

test('deployed, the website’s sign-in is open', () => {
  assert.equal(SITE_SIGNIN_OPEN, true);
});

test('with nothing said, the site answers as it does open', async () => {
  const open = await setup(true);
  const unsaid = await setup(undefined);
  for (const path of ['/', '/signs/seven-twelve', '/signin', '/you']) {
    const a = await open.request(path);
    const b = await unsaid.request(path);
    assert.equal(a.res.status, b.res.status, path);
    assert.equal(a.html, b.html, path);
  }
});

test('shut, as it was until Jamie opened it: no sign-in, no /you, no marker, Quiz’s own cookie', async () => {
  const shut = await setup(false);
  for (const path of [
    '/',
    '/signs',
    '/signs/seven-twelve',
    '/players',
    '/about',
    '/signin',
    '/signin?l=01JLOGIN&t=tok'
  ]) {
    const a = await shut.request(path);
    const signedIn = await shut.request(path, { as: 'ada' });
    assert.equal(a.res.status, 200, path);
    assert.equal(a.html, signedIn.html, path);
    assert.deepEqual(signedIn.cookies, [], path);
    assert.ok(!a.html.includes('class="you"'), path);
    assert.ok(!a.html.includes('rsm_me'), path);
  }
  for (const path of ['/you', '/signin/code', '/signin/link?l=x&t=y', '/post']) {
    assert.equal((await shut.request(path, { as: 'ada' })).res.status, 404, path);
  }
  const posted = await shut.request('/signin', { form: { email: 'pat@example.com' } });
  assert.equal(posted.res.status, 404);
  assert.equal(shut.mailer.sent.length, 0);
  // Quiz keeps its own cookie, on its own host.
  await shut.request('/signin', { form: { email: 'pat@example.com' }, front: 'quiz' });
  const code = /code is (\d{6})/.exec(shut.mailer.sent[0]!.subject)![1]!;
  const loginId = /l=([0-9A-Z]{26})/.exec(shut.mailer.sent[0]!.text)![1]!;
  const done = await shut.request('/signin/code', { form: { login: loginId, code }, front: 'quiz' });
  assert.ok(cookieNamed(done.cookies, 'rsm_quiz'));
  assert.ok(!cookieNamed(done.cookies, 'rsm_session'));
  assert.ok(!cookieNamed(done.cookies, 'rsm_me'));
  assert.ok(!cookieNamed(done.cookies, 'rsm_quiz')!.includes('Domain='), 'Quiz’s host only');
});

test('open, cached pages say Sign in, set no cookie and are the same for everyone', async () => {
  const t = await setup(true);
  for (const path of ['/', '/signs', '/signs/seven-twelve', '/players', '/about', '/nope']) {
    const out = await t.request(path);
    const signedIn = await t.request(path, { as: 'ada' });
    assert.equal(out.html, signedIn.html, `${path} is the same signed in`);
    assert.deepEqual(signedIn.cookies, [], `${path} sets no cookie`);
    assert.ok(out.html.includes('<a class="you" href="/signin">Sign in</a>'), path);
    assert.ok(out.html.includes('rsm_me'), `${path} carries the marker script`);
    if (out.res.status === 200) assert.match(out.res.headers.get('cache-control') ?? '', /s-maxage/, path);
  }
});

test('open, the iPhone app’s /signin link lands as it always has', async () => {
  const shut = await setup(false);
  const t = await setup(true);
  const path = '/signin?l=01JLOGIN&t=secret-token-value';
  const a = await shut.request(path);
  const b = await t.request(path, { as: 'ada' });
  assert.equal(b.res.status, 200);
  assert.equal(b.html, a.html);
  assert.equal(b.res.headers.get('cache-control'), 'no-store');
  assert.equal(b.res.headers.get('referrer-policy'), a.res.headers.get('referrer-policy'));
  assert.deepEqual(b.cookies, []);
});

test('open, sign in by code on the site: its own email, the shared cookie and a marker with no secret', async () => {
  const t = await setup(true);
  for (const origin of ['https://evil.example', QUIZ, null]) {
    const refused = await t.request('/signin', { form: { email: 'pat@example.com' }, origin });
    assert.equal(refused.res.status, 400, String(origin));
    assert.equal(refused.res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(t.mailer.sent.length, 0, 'another site’s form sends nothing');

  const page = await t.request('/signin');
  assert.equal(page.res.headers.get('cache-control'), 'no-store');
  assert.ok(plain(page.html).includes('One account for roadsignmath.xyz, Quiz and the Road Sign Math app.'));
  assert.ok(page.html.includes('href="https://example.test/rules"'), 'the house rules line');

  const sent = await t.request('/signin', { form: { email: 'pat@example.com' } });
  assert.equal(sent.res.status, 303);
  assert.match(sent.location!, /^\/signin\/code\?l=[0-9A-Z]{26}$/);
  const mail = t.mailer.sent[0]!;
  assert.ok(mail.text.includes('Tap to sign in to roadsignmath.xyz:'));
  assert.ok(mail.html!.includes('/email/signin-site'));
  assert.match(
    mail.text,
    /https:\/\/example\.test\/signin\/link\?l=[0-9A-Z]{26}&t=/,
    'not /signin, which the app opens'
  );
  const code = /code is (\d{6})/.exec(mail.subject)![1]!;
  const loginId = /l=([0-9A-Z]{26})/.exec(sent.location!)![1]!;
  const codePage = await t.request(sent.location!);
  assert.equal(codePage.res.headers.get('cache-control'), 'no-store');
  assert.ok(codePage.html.includes('action="/signin/code"'));

  const done = await t.request('/signin/code', { form: { login: loginId, code } });
  assert.equal(done.res.status, 303);
  assert.equal(done.location, '/signin/name', 'a new player names themself first');
  const session = cookieNamed(done.cookies, 'rsm_session')!;
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Domain=example\.test/, 'one cookie for the site and Quiz');
  const marker = cookieNamed(done.cookies, 'rsm_me')!;
  assert.ok(!/HttpOnly/.test(marker), 'the header’s script reads it');
  const token = decodeURIComponent(/^rsm_session=([^;]+)/.exec(session)![1]!);
  // The secret is base64url, so it can hold a `_` itself: take all of it, not a piece.
  const secret = /^rsm_[0-9A-Z]{26}_(.{43})$/.exec(token)![1]!;
  assert.ok(!marker.includes(secret), 'the marker holds no secret');
  assert.match(decodeURIComponent(/^rsm_me=([^;]+)/.exec(marker)![1]!), /^1\.[0-9A-F]{6}\.\.\?$/i);

  const cookie = `rsm_session=${token}`;
  const name = await t.request('/signin/name', { cookie });
  assert.ok(name.html.includes('Save my name'));
  const named = await t.request('/signin/name', { form: { name: 'Pat' }, cookie });
  assert.equal(named.location, '/you');
  assert.match(decodeURIComponent(cookieNamed(named.cookies, 'rsm_me')!), /^rsm_me=1\.[0-9A-F]{6}\.\.P;/i);
  const you = await t.request('/you', { cookie });
  assert.equal(you.res.status, 200);
  assert.equal(you.res.headers.get('cache-control'), 'no-store');
  assert.equal(you.res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(you.html.includes('<a class="you" href="/you"'), 'the face, drawn on the server');
  assert.ok(plain(you.html).includes('Signs you posted'));
  assert.equal(t.newsletter.list.size, 1, 'a new player joins the newsletter');
  assert.deepEqual(
    (await t.store.getPlayer(/rsm_([0-9A-Z]+)_/.exec(token)![1]!))!.newsletterTags ?? [],
    [],
    'untagged'
  );
});

test('open, the email’s link lands on a page that changes nothing until its button posts', async () => {
  const t = await setup(true);
  await t.request('/signin', { form: { email: 'pat@example.com' } });
  const link = /(https:\/\/example\.test\/signin\/link\?[^\s]+)/.exec(t.mailer.sent[0]!.text)![1]!;
  const url = new URL(link);
  const landing = await t.request(url.pathname + url.search);
  assert.equal(landing.res.status, 200);
  assert.deepEqual(landing.cookies, []);
  assert.ok(landing.html.includes('Sign in to Road Sign Math'));
  assert.ok(!landing.html.includes('data-site='), 'its address carries the token, so nothing counts it');
  const login = url.searchParams.get('l')!;
  const posted = await t.request('/signin/link', { form: { login, token: url.searchParams.get('t')! } });
  assert.equal(posted.res.status, 303);
  assert.ok(cookieNamed(posted.cookies, 'rsm_session'));
  const again = await t.request('/signin/link', { form: { login, token: url.searchParams.get('t')! } });
  assert.equal(again.res.status, 400, 'a link works once');
});

test('open, Quiz reads its old cookie, moves it to the shared one, and the site reads that', async () => {
  const t = await setup(true);
  const quiz = await t.request('/profile', { cookie: `rsm_quiz=${t.tokens.ada}`, front: 'quiz' });
  assert.equal(quiz.res.status, 200);
  assert.match(cookieNamed(quiz.cookies, 'rsm_session')!, /Domain=example\.test/);
  assert.match(cookieNamed(quiz.cookies, 'rsm_quiz')!, /Max-Age=0/, 'the old one goes');
  assert.ok(cookieNamed(quiz.cookies, 'rsm_me'));
  const site = await t.request('/you', { as: 'ada' });
  assert.equal(site.res.status, 200);
  assert.ok(plain(site.html).includes(ada.name));
  // Quiz shut again later still reads the shared cookie.
  const shut = await setup(false);
  assert.equal((await shut.request('/profile', { as: 'ada', front: 'quiz' })).res.status, 200);
});

test('open, /you lists your signs, held and hidden with why, and their photos only to you', async () => {
  const t = await setup(true);
  assert.equal((await t.request('/you')).location, '/signin', 'signed out, sign in first');
  const you = plain((await t.request('/you', { as: 'ada' })).html);
  assert.ok(you.includes('Held Junction'));
  assert.ok(you.includes('Held'));
  assert.ok(you.includes('A person will look at this one. Only you can see it.'));
  assert.ok(you.includes('Seven Twelve'));
  assert.ok(!you.includes('Bens Hidden'), 'only your own');
  const mine = await t.request(`/you/photos/ph-${HELD}/thumb.jpg`, { as: 'ada' });
  assert.equal(mine.res.status, 200);
  assert.equal(mine.res.headers.get('cache-control'), 'no-store');
  assert.equal((await t.request(`/you/photos/ph-${BENS}/thumb.jpg`, { as: 'ada' })).res.status, 404);
  assert.equal((await t.request(`/you/photos/ph-${HELD}/thumb.jpg`)).res.status, 404);
  const bens = plain((await t.request('/you', { as: 'ben' })).html);
  assert.ok(bens.includes('Bens Hidden') && bens.includes('Hidden'));
});

test('open, deleting a sign asks first, and only a POST from the site deletes it', async () => {
  const t = await setup(true);
  const ask = await t.request(`/you/signs/${HELD}/delete`, { as: 'ada' });
  assert.equal(ask.res.status, 200);
  assert.ok(plain(ask.html).includes('Delete Held Junction?'));
  assert.ok(await t.store.getSign(HELD), 'asking changes nothing');
  const forged = await t.request(`/you/signs/${HELD}/delete`, { as: 'ada', form: {}, origin: 'https://evil.example' });
  assert.equal(forged.res.status, 400);
  assert.ok(await t.store.getSign(HELD));
  const notYours = await t.request(`/you/signs/${BENS}/delete`, { as: 'ada', form: {} });
  assert.equal(notYours.location, '/you');
  assert.ok(await t.store.getSign(BENS));
  const done = await t.request(`/you/signs/${HELD}/delete`, { as: 'ada', form: {} });
  assert.equal(done.location, '/you?done=deleted');
  assert.equal(await t.store.getSign(HELD), undefined);
  assert.ok(plain((await t.request(done.location!, { as: 'ada' })).html).includes('Your sign is deleted.'));
});

test('open, the profile saves through the moderated update, then sign out and delete the account', async () => {
  const t = await setup(true);
  const saved = await t.request('/you', {
    as: 'ben',
    form: { name: 'Ben', bio: 'Road tripper', website: '', home: '' }
  });
  assert.equal(saved.location, '/you?done=saved');
  assert.equal((await t.store.getPlayer(ben.id))!.bio, 'Road tripper');
  const out = await t.request('/you/signout', { as: 'ben', form: {} });
  assert.equal(out.location, '/');
  assert.match(cookieNamed(out.cookies, 'rsm_session')!, /Max-Age=0/);
  assert.match(cookieNamed(out.cookies, 'rsm_me')!, /Max-Age=0/);
  assert.equal((await t.request('/you', { as: 'ben' })).location, '/signin', 'that session is over');

  const ask = await t.request('/you/delete', { as: 'ada' });
  assert.ok(plain(ask.html).includes('the same account as the app and Quiz'));
  assert.ok(await t.store.getPlayer(ada.id), 'asking changes nothing');
  const gone = await t.request('/you/delete', { as: 'ada', form: {} });
  assert.equal(gone.location, '/you/deleted');
  assert.equal(await t.store.getPlayer(ada.id), undefined);
  assert.ok(plain((await t.request('/you/deleted')).html).includes('here, in Quiz and in the app'));
});

test('every answer under the signed-in paths is uncached, even a 404 and a redirect', async () => {
  const t = await setup(true);
  for (const path of ['/you', '/you/nope', '/post', '/signin/nope', '/signin/code?l=nothing']) {
    for (const as of [undefined, 'ada']) {
      const { res } = await t.request(path, { as });
      assert.equal(res.headers.get('cache-control'), 'no-store', `${path} ${as ?? ''}`);
    }
  }
});

test('the marker is a colour, a photo id and a letter; the header script checks each part', () => {
  assert.equal(markerOf({ name: 'pat', avatarColor: '#1F6FB2' }), '1.1F6FB2..P');
  assert.equal(markerOf({ name: 'Ada', avatarColor: '#1F6FB2', avatar: 'av-01' }), '1.1F6FB2.av-01.A');
  assert.equal(markerOf({ name: 'X', avatarColor: 'red;x', avatar: '../x' }), '1.006348..X');
  assert.ok(WHO_SCRIPT.includes('textContent'), 'the letter goes in as text');
  assert.ok(!WHO_SCRIPT.includes('innerHTML'));
  const html = '<html><head></head><body><header><a class="get" href="/app">Get</a></header></body></html>';
  const once = withSignIn(html);
  assert.equal(withSignIn(once), once, 'added once');
  assert.ok(once.indexOf('class="you"') < once.indexOf('class="get"'));
});
