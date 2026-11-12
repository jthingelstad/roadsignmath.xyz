// Quiz open (`quizOpen`), through its front: signing in by code and by link, a name, and solving
// signs the ways the boards draw them. Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/api/app.ts';
import { check } from '../src/domain/equation.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { CHECKER_JS, CHECKER_SOURCE_SHA } from '../src/quiz/checker.ts';
import { draw } from '../src/quiz/data.ts';
import { quizOrigin } from '../src/quiz/quiz.tsx';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';

const nameless: Player = {
  id: '01JNNNNNNNNNNNNNNNNNNNNNNN',
  handle: 'pnameless00',
  name: '',
  avatarColor: '#B01C33',
  createdAt: '2026-01-03T00:00:00.000Z'
};

async function setup() {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    quizOpen: true
  });
  const tokens: Record<string, string> = {};
  for (const player of [ada, ben, nameless]) {
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
  // A sign Ada solved, and one she posted without the math.
  await store.putSign(sign({ id: 'S1', title: 'Seven Twelve' }));
  await store.putWay(way('S1'));
  await store.putSign(
    sign({
      id: 'S2',
      title: 'Unsolved Junction',
      firstWay: undefined,
      wayCount: 0,
      postedAt: '2026-01-11T12:00:00.000Z'
    })
  );
  const quiz = async (
    path: string,
    init: { method?: string; form?: Record<string, string>; as?: string; cookie?: string; origin?: string | null } = {}
  ) => {
    const headers: Record<string, string> = { 'X-RSM-Front': 'quiz' };
    const cookie = init.cookie ?? (init.as ? `rsm_quiz=${tokens[init.as]}` : undefined);
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
      if (init.origin !== null) headers.origin = init.origin ?? QUIZ;
    }
    const res = await app.request(path, { method: init.method ?? (init.form ? 'POST' : 'GET'), headers, body });
    return { res, html: await res.text(), location: res.headers.get('location') };
  };
  return { store, mailer, quiz, tokens };
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const decoded = (html: string) =>
  html
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

test('Quiz’s origin is the site’s with quiz. in front, and localhost stays itself', () => {
  assert.equal(quizOrigin('https://roadsignmath.xyz'), 'https://quiz.roadsignmath.xyz');
  assert.equal(quizOrigin('http://localhost:8788'), 'http://localhost:8788');
});

test('signed out, home says how it works; every answer is private and uncached', async () => {
  const t = await setup();
  const { res, html } = await t.quiz('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(html.includes('Find the math in a road sign.'));
  assert.ok(html.includes('Sign in to play'));
  assert.ok(html.includes(`${SITE}/p/ph-S1/large.jpg`), 'photos come from the site');
  assert.ok(!html.includes('Coming soon'));
  const next = await t.quiz('/next');
  assert.equal(next.res.status, 303);
  assert.equal(next.location, '/signin');
});

test('sign in by code: the Quiz email, a cookie only Quiz’s pages send, then a name', async () => {
  const t = await setup();
  const refused = await t.quiz('/signin', { form: { email: 'pat@example.com' }, origin: 'https://evil.example' });
  assert.equal(refused.res.status, 400);
  assert.equal(t.mailer.sent.length, 0, 'another site’s form sends nothing');
  const bare = await t.quiz('/signin', { form: { email: 'pat@example.com' }, origin: null });
  assert.equal(bare.res.status, 400, 'nor a POST with no Origin');

  const started = await t.quiz('/signin', { form: { email: 'pat@example.com' } });
  assert.equal(started.res.status, 200);
  assert.ok(decoded(started.html).includes('Check your email'));
  const mail = t.mailer.sent[0];
  assert.equal(mail.to, 'pat@example.com');
  assert.match(mail.text, /Tap to sign in to Road Sign Math Quiz:\nhttps:\/\/quiz\.example\.test\/signin\?l=/);
  assert.match(mail.text, /Or type this code on the sign-in page: \d{6}/);
  assert.ok(mail.html!.includes('/email/signin-quiz'), 'its own pixel path');
  const code = /code is (\d{6})/.exec(mail.subject)![1];
  const loginId = /name="login" value="([^"]+)"/.exec(started.html)![1];

  const wrong = await t.quiz('/signin/code', {
    form: { login: loginId, email: 'pat@example.com', code: code === '000000' ? '111111' : '000000' }
  });
  assert.equal(wrong.res.status, 400);
  assert.ok(decoded(wrong.html).includes('didn’t work') || wrong.html.includes('didn&#39;t'));

  const done = await t.quiz('/signin/code', { form: { login: loginId, email: 'pat@example.com', code } });
  assert.equal(done.res.status, 303);
  assert.equal(done.location, '/name');
  const cookie = done.res.headers.get('set-cookie')!;
  assert.match(cookie, /^rsm_quiz=rsm_[0-9A-Z]{26}_[\w-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=15552000/);
  const jar = cookie.split(';')[0];

  assert.equal((await t.quiz('/next', { cookie: jar })).location, '/name', 'a name comes first');
  const named = await t.quiz('/name', { cookie: jar, form: { name: 'Pat' } });
  assert.equal(named.location, '/next');
  const next = await t.quiz('/next', { cookie: jar });
  assert.equal(next.res.status, 303);
  assert.match(next.location!, /^\/signs\/(seven-twelve|unsolved-junction)$/);
  const pat = await t.store.getPlayer(/rsm_([0-9A-Z]{26})_/.exec(jar)![1]);
  assert.equal(pat?.name, 'Pat');
});

test('the email’s link opens a page that changes nothing; its button signs in', async () => {
  const t = await setup();
  await t.quiz('/signin', { form: { email: ada.email! } });
  const link = /(https:\/\/quiz\.example\.test\/signin\?[^\s]+)/.exec(t.mailer.sent[0].text)![1];
  const opened = await t.quiz(new URL(link).pathname + new URL(link).search);
  assert.equal(opened.res.status, 200);
  assert.equal(opened.res.headers.get('set-cookie'), null, 'a mail scanner opening it signs nobody in');
  const loginId = /name="login" value="([^"]+)"/.exec(opened.html)![1];
  const token = /name="token" value="([^"]+)"/.exec(opened.html)![1];
  const done = await t.quiz('/signin/link', { form: { login: loginId, token } });
  assert.equal(done.res.status, 303);
  assert.equal(done.location, '/next', 'Ada has a name already: straight to the signs');
  assert.match(done.res.headers.get('set-cookie')!, /^rsm_quiz=rsm_01JAAAAAAAAAAAAAAAAAAAAAAA_/);
  const again = await t.quiz('/signin/link', { form: { login: loginId, token } });
  assert.equal(again.res.status, 400, 'a link works once');
  assert.ok(again.html.includes('That link has ended'));
});

test('solving: reordered, found too, a new way, your own again, the first way, and bad math', async () => {
  const t = await setup();
  const solve = (slug: string, text: string) => t.quiz(`/signs/${slug}/solve`, { as: 'ben', form: { text } });

  const page = await t.quiz('/signs/seven-twelve', { as: 'ben' });
  assert.equal(page.res.status, 200);
  for (const id of [
    'id="solve"',
    'id="typed"',
    'id="pad"',
    'id="math"',
    'id="status"',
    'id="send"',
    'data-v="12"',
    'data-k="del"'
  ]) {
    assert.ok(page.html.includes(id), id);
  }
  assert.ok(page.html.includes('window.RSMCheck') || page.html.includes('RSMCheck'), 'the checker rides along');

  const turned = await solve('seven-twelve', '19 = 12 + 7');
  assert.equal(turned.res.status, 409);
  assert.ok(decoded(turned.html).includes('That’s Ada’s way, turned around.'));

  const too = await solve('seven-twelve', '7 + 12 = 19');
  assert.equal(too.res.status, 303);
  assert.equal(too.location, '/signs/seven-twelve/found?way=way-S1');
  const tooPage = decoded((await t.quiz(too.location!, { as: 'ben' })).html);
  assert.ok(tooPage.includes('You found it too.'));
  assert.ok(tooPage.includes('Same as Ada'));
  assert.ok(plain(tooPage).includes('Found by Ada, also found by Ben'), 'the dot reads as a comma');
  const coFinds = await t.store.listCoFinds('S1');
  assert.deepEqual(
    coFinds.map((c) => [c.playerId, c.via]),
    [[ben.id, 'quiz']]
  );

  const fresh = await solve('seven-twelve', '19 − 12 = 7');
  assert.equal(fresh.res.status, 303);
  const freshPage = decoded((await t.quiz(fresh.location!, { as: 'ben' })).html);
  assert.ok(freshPage.includes('Nobody had that one.'));
  assert.ok(freshPage.includes('Both sides come to 7, and you used all three numbers.'));
  assert.ok(freshPage.includes('The other way on this sign'));

  const mine = await solve('seven-twelve', '19 − 12 = 7');
  assert.equal(mine.res.status, 409);
  assert.ok(decoded(mine.html).includes('You found that way already.'));

  const bad = await solve('seven-twelve', '7 + 12 = 20');
  assert.equal(bad.res.status, 400);
  assert.ok(bad.html.includes('class="oops"'));
  assert.ok(bad.html.includes('value="7 + 12 = 20"'), 'what was tried stays in the field');

  const unsolved = decoded((await t.quiz('/signs/unsolved-junction', { as: 'ben' })).html);
  assert.ok(unsolved.includes('Nobody’s found the math yet'));
  assert.ok(unsolved.includes('Ada posted this one without the math.'));
  const first = await solve('unsolved-junction', '7 + 12 = 19');
  assert.equal(first.res.status, 303);
  const firstPage = decoded((await t.quiz(first.location!, { as: 'ben' })).html);
  assert.ok(firstPage.includes('You found the math.'));
  assert.ok(plain(firstPage).includes('Found by Ada, first way by Ben'));
  assert.ok(firstPage.includes('Tag Team'));

  const solved = decoded((await t.quiz('/solved', { as: 'ben' })).html);
  assert.ok(solved.includes('Signs you’ve solved'));
  assert.ok(solved.includes('First way'));
  assert.ok(solved.includes('New way'), 'Seven Twelve shows its newest solve, the new way');
  assert.ok(solved.includes(`${SITE}/players/ben`));

  const done = await t.quiz('/next', { as: 'ben' });
  assert.equal(done.res.status, 200, 'both signs solved: nothing left');
  assert.ok(decoded(done.html).includes('You’ve done every sign.'));
});

test('a player’s own signs aren’t drawn, a nameless player gives a name first, and the ways page shows who', async () => {
  const t = await setup();
  const ada1 = await t.quiz('/next', { as: 'ada' });
  assert.equal(ada1.res.status, 200, 'Ada posted both: none to draw');
  assert.ok(decoded(ada1.html).includes('You’ve done every sign.'));
  assert.equal((await t.quiz('/signs/seven-twelve', { as: 'pnameless00' })).location, '/name');
  const ways = decoded((await t.quiz('/signs/seven-twelve/ways', { as: 'ben' })).html);
  assert.ok(ways.includes('The ways on this sign'));
  assert.ok(ways.includes('Found by <b>Ada</b>'));
  assert.ok(ways.includes('Looking doesn’t count against you'));
  const missing = await t.quiz('/signs/nowhere', { as: 'ben' });
  assert.equal(missing.res.status, 404);
});

test('a bad cookie is cleared and sends you to sign in; signing out ends the session', async () => {
  const t = await setup();
  const stale = await t.quiz('/next', { cookie: 'rsm_quiz=rsm_01JBBBBBBBBBBBBBBBBBBBBBBB_nope' });
  assert.equal(stale.location, '/signin');
  assert.match(stale.res.headers.get('set-cookie')!, /rsm_quiz=;.*Max-Age=0/);
  const out = await t.quiz('/signout', { as: 'ben', form: {} });
  assert.equal(out.location, '/');
  assert.equal((await t.quiz('/next', { as: 'ben' })).location, '/signin');
});

test('draw leaves out the sign just skipped when another is left', () => {
  const a = sign({ id: 'A', title: 'A' });
  const b = sign({ id: 'B', title: 'B' });
  for (const r of [0, 0.5, 0.99]) assert.equal(draw([a, b], 'a', () => r)?.slug, 'b');
  assert.equal(draw([a], 'a')?.slug, 'a', 'the only one left comes back');
  assert.equal(draw([]), undefined);
});

test('the browser’s checker is today’s equation.ts and answers as the server does', () => {
  const source = readFileSync(new URL('../src/domain/equation.ts', import.meta.url));
  assert.equal(
    CHECKER_SOURCE_SHA,
    createHash('sha256').update(source).digest('hex'),
    'run npm run quiz-checker after changing the checker'
  );
  const context: { RSMCheck?: { check: typeof check } } = {};
  runInNewContext(CHECKER_JS.replace(/^var RSMCheck=/, 'this.RSMCheck='), context);
  const browser = context.RSMCheck ?? (runInNewContext(`${CHECKER_JS};RSMCheck`) as { check: typeof check });
  const vectors = JSON.parse(readFileSync(new URL('../contracts/equation-vectors.json', import.meta.url), 'utf8')) as {
    checks: { text: string }[];
    same_way: { a: string; b: string }[];
  };
  const texts = [
    ...vectors.checks.map((v) => v.text),
    ...vectors.same_way.flatMap((v) => [v.a, v.b]),
    '',
    '7 +',
    '1 ÷ 0 = 1'
  ];
  // Compared as JSON: the bundle's objects come from another realm.
  for (const text of texts) assert.equal(JSON.stringify(browser.check(text)), JSON.stringify(check(text)), text);
});
