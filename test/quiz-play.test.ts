// Quiz open (`quizOpen`), through its front: signing in by code and by link, a name, and solving
// signs the ways the boards draw them. Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { check, numbersLeftOut, numbersNotOnSign } from '../src/domain/equation.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { CHECKER_JS, CHECKER_SOURCE_SHA } from '../src/quiz/checker.ts';
import { KEYPAD_JS } from '../src/quiz/keypad.ts';
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
  const photos = new MemoryPhotoStore();
  const moderator = new ScriptedModerator();
  const newsletter = new MemoryNewsletter();
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer,
    photos,
    moderator,
    newsletter,
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
    init: {
      method?: string;
      form?: Record<string, string>;
      /** A multipart form, as a file input sends it. */
      upload?: FormData;
      as?: string;
      cookie?: string;
      origin?: string | null;
    } = {}
  ) => {
    const headers: Record<string, string> = { 'X-RSM-Front': 'quiz' };
    const cookie = init.cookie ?? (init.as ? `rsm_quiz=${tokens[init.as]}` : undefined);
    if (cookie) headers.cookie = cookie;
    let body: string | FormData | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.upload) body = init.upload;
    if (body !== undefined && init.origin !== null) headers.origin = init.origin ?? QUIZ;
    const res = await app.request(path, {
      method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body
    });
    return { res, html: await res.text(), location: res.headers.get('location') };
  };
  return { app, store, mailer, photos, moderator, newsletter, quiz, tokens };
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

test('“Try this one in Quiz”: signing in on the way there lands on that sign, and only a slug is carried', async () => {
  const t = await setup();
  const out = await t.quiz('/signs/seven-twelve');
  assert.equal(out.location, '/signin?to=seven-twelve', 'signed out: sign in first, keeping the sign');
  const page = await t.quiz('/signin?to=seven-twelve');
  assert.ok(page.html.includes('<input type="hidden" name="to" value="seven-twelve"/>'));
  const started = await t.quiz('/signin', { form: { email: 'pat@example.com', to: 'seven-twelve' } });
  assert.equal(
    (started.html.match(/name="to" value="seven-twelve"/g) ?? []).length,
    2,
    'the code and send-again forms'
  );
  assert.ok(started.html.includes('href="/signin?to=seven-twelve"'), 'a different email keeps it too');
  const code = /code is (\d{6})/.exec(t.mailer.sent[0].subject)![1];
  const loginId = /name="login" value="([^"]+)"/.exec(started.html)![1];
  const done = await t.quiz('/signin/code', {
    form: { login: loginId, email: 'pat@example.com', code, to: 'seven-twelve' }
  });
  assert.equal(done.location, '/name?to=seven-twelve', 'a new player gives a name first');
  const jar = done.res.headers.get('set-cookie')!.split(';')[0];
  const naming = await t.quiz('/name?to=seven-twelve', { cookie: jar });
  assert.ok(naming.html.includes('name="to" value="seven-twelve"'));
  const named = await t.quiz('/name', { cookie: jar, form: { name: 'Pat', to: 'seven-twelve' } });
  assert.equal(named.location, '/signs/seven-twelve');
  assert.equal((await t.quiz('/signin?to=seven-twelve', { cookie: jar })).location, '/signs/seven-twelve');

  // By the email's link instead of the code: the link carries the sign too.
  const linked = await t.quiz('/signin', { form: { email: ada.email!, to: 'unsolved-junction' } });
  assert.equal(linked.res.status, 200);
  const link = /(https:\/\/quiz\.example\.test\/signin\?[^\s]+)/.exec(t.mailer.sent.at(-1)!.text)![1];
  assert.match(link, /&to=unsolved-junction$/);
  const opened = await t.quiz(new URL(link).pathname + new URL(link).search);
  assert.ok(opened.html.includes('name="to" value="unsolved-junction"'));
  const loginId2 = /name="login" value="([^"]+)"/.exec(opened.html)![1];
  const token = /name="token" value="([^"]+)"/.exec(opened.html)![1];
  const viaLink = await t.quiz('/signin/link', { form: { login: loginId2, token, to: 'unsolved-junction' } });
  assert.equal(viaLink.location, '/signs/unsolved-junction', 'Ada has a name: straight to the sign');

  for (const to of ['//evil.example', 'https://evil.example', '../next', 'Seven', 'a b', '-x', 'x'.repeat(81)]) {
    assert.equal((await t.quiz(`/signin?to=${encodeURIComponent(to)}`, { cookie: jar })).location, '/next', to);
    const blank = await t.quiz(`/signin?to=${encodeURIComponent(to)}`);
    assert.ok(!blank.html.includes('name="to"'), to);
  }
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
  assert.equal((await t.quiz('/signs/seven-twelve', { as: 'pnameless00' })).location, '/name?to=seven-twelve');
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

test('a way found too stays off the solved list once its author is blocked', async () => {
  const t = await setup();
  const cy: Player = { ...ben, id: '01JCCCCCCCCCCCCCCCCCCCCCCC', handle: 'cy', name: 'Cy' };
  await addPlayer(t.store, cy);
  // Ada's sign, with a second way by Cy that Ben then finds too.
  await t.store.putWay(
    way('S1', { id: 'way-cy', playerId: cy.id, text: '19 − 12 = 7', createdAt: '2026-01-12T00:00:00.000Z' })
  );
  const too = await t.quiz('/signs/seven-twelve/solve', { form: { text: '19 − 12 = 7' }, as: 'ben' });
  assert.equal(too.location, '/signs/seven-twelve/found?way=way-cy');
  const before = decoded((await t.quiz('/solved', { as: 'ben' })).html);
  assert.ok(before.includes('Seven Twelve') && before.includes('19 − 12 = 7'));
  await t.store.putBlock({ playerId: ben.id, blockedId: cy.id, createdAt: '2026-01-13T00:00:00.000Z' });
  const after = decoded((await t.quiz('/solved', { as: 'ben' })).html);
  assert.ok(!after.includes('19 − 12 = 7'), 'Cy’s way is hidden from Ben');
  assert.ok(!after.includes('Seven Twelve'), 'and Ben solved it only by finding that way too');
  const next = await t.quiz('/next', { as: 'ben' });
  assert.equal(next.location, '/signs/unsolved-junction', 'it isn’t drawn for him again either');
});

/** Just enough DOM for the keypad: elements that keep their text, classes and listeners. */
class FakeElement {
  dataset: Record<string, string>;
  hidden = false;
  disabled = false;
  required = true;
  value = '';
  textContent = '';
  className = '';
  tagName = 'DIV';
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name))
  };
  private readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(dataset: Record<string, string> = {}) {
    this.dataset = dataset;
  }
  addEventListener(type: string, f: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(f);
  }
  append(...children: FakeElement[]) {
    this.textContent += children.map((c) => c.textContent).join(' ');
  }
  setAttribute() {}
  click() {
    for (const f of this.listeners.click ?? []) f({});
  }
}

function keypad(values: string[]) {
  const tiles = values.map((v) => new FakeElement({ v }));
  const keys = ['+', '−', '×', '÷', '=', '(', ')', 'del'].map((k) => new FakeElement({ k }));
  const field = new FakeElement();
  const pad = Object.assign(new FakeElement(), {
    querySelectorAll: (sel: string) => (sel === '[data-v]' ? tiles : keys)
  });
  const form = Object.assign(new FakeElement(), { querySelector: () => field });
  const els: Record<string, FakeElement> = {
    solve: form,
    pad,
    math: new FakeElement(),
    status: new FakeElement(),
    send: new FakeElement(),
    typed: new FakeElement()
  };
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els[id],
      createElement: () => new FakeElement(),
      addEventListener: () => {}
    }
  };
  runInNewContext(`${CHECKER_JS};this.window={RSMCheck:RSMCheck};`, context);
  runInNewContext(KEYPAD_JS, context);
  const key = (k: string) => keys.find((e) => e.dataset.k === k)!.click();
  return { tiles, key, field, status: els.status, send: els.send };
}

test('the keypad never runs two tiles together, and holds Send for math the sign can’t make', () => {
  const pad = keypad(['1', '2', '12']);
  pad.tiles[0].click();
  pad.tiles[1].click();
  assert.equal(pad.field.value, '1', 'a tile straight after a tile is refused: 1 and 2 aren’t 12');
  pad.key('+');
  pad.tiles[1].click();
  pad.key('=');
  pad.tiles[2].click();
  assert.equal(pad.field.value, '1 + 2 = 12');
  assert.equal(pad.send.disabled, true);
  pad.key('del');
  pad.key('del');
  pad.key('×');
  pad.key('(');
  pad.tiles[2].click();
  pad.key('÷');
  pad.key('(');
  assert.equal(pad.field.value, '1 + 2 × (12 ÷ (');
  assert.equal(pad.send.disabled, true);

  const works = keypad(['7', '12', '19']);
  works.tiles[0].click();
  works.key('+');
  works.tiles[1].click();
  works.key('=');
  works.tiles[2].click();
  assert.equal(works.field.value, '7 + 12 = 19');
  assert.equal(works.send.disabled, false);
  assert.ok(works.status.textContent.includes('It works: both sides are 19.'));

  // True math that leaves a number out holds Send and names it (Jamie, 2026-11-12).
  const short = keypad(['2', '2', '4', '8']);
  short.tiles[0].click();
  short.key('+');
  short.tiles[1].click();
  short.key('=');
  short.tiles[2].click();
  assert.equal(short.field.value, '2 + 2 = 4');
  assert.equal(short.send.disabled, true);
  assert.ok(short.status.textContent.includes('Now use every number: 8 is left out.'));

  // The keypad's guard is the server's own count of the sign's numbers.
  const context: {
    RSMCheck?: { numbersNotOnSign: typeof numbersNotOnSign; numbersLeftOut: typeof numbersLeftOut };
  } = {};
  runInNewContext(`${CHECKER_JS};this.RSMCheck=RSMCheck;`, context);
  for (const [used, on] of [
    [
      ['12', '12'],
      ['1', '2', '12']
    ],
    [
      ['7', '12', '19'],
      ['7', '12', '19']
    ],
    [['1.50'], ['1.5']]
  ])
    assert.equal(
      JSON.stringify([context.RSMCheck!.numbersNotOnSign(used, on), context.RSMCheck!.numbersLeftOut(used, on)]),
      JSON.stringify([numbersNotOnSign(used, on), numbersLeftOut(used, on)])
    );
});

// ---- Your profile

const jpeg = (color = '#f2b300') =>
  sharp({ create: { width: 300, height: 120, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

const upload = async (bytes: Buffer | string, type = 'image/jpeg') => {
  const form = new FormData();
  form.set('photo', new Blob([bytes], { type }), 'me.jpg');
  return form;
};

test('a player’s profile photo shows in Quiz’s header and beside their ways; without one, their letter', async () => {
  const t = await setup();
  await t.store.setAvatar(ada.id, 'av-ada');
  const mine = await t.quiz('/solved', { as: 'ada' });
  assert.ok(mine.html.includes(`<a class="me" href="/profile"`), 'the header leads to the profile');
  assert.ok(mine.html.includes(`<img src="${SITE}/p/av-ada/thumb.jpg" alt=""/>`), 'her photo, from the site');
  const ways = await t.quiz('/signs/seven-twelve/ways', { as: 'ben' });
  assert.ok(ways.html.includes(`${SITE}/p/av-ada/thumb.jpg`), 'Ada’s face beside her way');
  const header = /<header[\s\S]*?<\/header>/.exec(ways.html)![0];
  assert.ok(!header.includes('/p/'), 'Ben has no photo');
  assert.match(plain(header), /Your profile ?B$/, 'so his letter shows');
  const profile = await t.quiz('/profile', { as: 'ada' });
  assert.ok(profile.html.includes(`${SITE}/p/av-ada/large.jpg`), 'drawn big, the large size');
});

test('the profile: name, bio, email only she sees, her page, and edits that keep what was typed', async () => {
  const t = await setup();
  assert.equal((await t.quiz('/profile')).location, '/signin', 'signed out, sign in first');
  const { res, html } = await t.quiz('/profile', { as: 'ada' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = decoded(plain(html));
  assert.ok(text.includes('Your profile'));
  assert.ok(html.includes('value="Ada"') && html.includes('value="Counts everything."'));
  assert.ok(text.includes('ada@example.com') && text.includes('Only you see your email.'));
  assert.ok(html.includes(`href="${SITE}/players/ada"`), 'her page on the site');
  assert.ok(html.includes('action="/profile/photo"') && html.includes('enctype="multipart/form-data"'));
  assert.ok(html.includes('action="/signout"') && html.includes('href="/profile/delete"'));
  assert.ok(!html.includes('href="/profile/photo/remove"'), 'no photo, nothing to remove');
  assert.ok(!html.includes('role="status"'));

  const ben = decoded(plain((await t.quiz('/profile', { as: 'ben' })).html));
  assert.ok(ben.includes('Your page on roadsignmath.xyz starts with the first way you find.'));
  assert.ok(!(await t.quiz('/profile', { as: 'ben' })).html.includes('/players/ben'), 'no link to a page not there');

  const saved = await t.quiz('/profile', { as: 'ada', form: { name: 'Ada Lovelace', bio: '' } });
  assert.equal(saved.res.status, 303);
  assert.equal(saved.location, '/profile?done=saved');
  const now = (await t.store.getPlayer(ada.id))!;
  assert.equal(now.name, 'Ada Lovelace');
  assert.ok(!now.bio, 'an empty bio takes it away');
  assert.equal(now.handle, 'ada', 'the page’s address stays');
  assert.ok((await t.quiz('/profile?done=saved', { as: 'ada' })).html.includes('Saved.'));
  assert.ok(!(await t.quiz('/profile?done=nope', { as: 'ada' })).html.includes('role="status"'));

  const blank = await t.quiz('/profile', { as: 'ada', form: { name: '  ', bio: 'Still counting.' } });
  assert.equal(blank.res.status, 400);
  assert.ok(blank.html.includes('Name is 1 to 40 characters.'));
  assert.ok(blank.html.includes('value="Still counting."'), 'what she typed stays');
  assert.equal((await t.store.getPlayer(ada.id))!.name, 'Ada Lovelace', 'nothing changed');
});

test('a profile photo: set through the moderator, refused in its words, replaced, removed after asking', async () => {
  const t = await setup();
  const set = await t.quiz('/profile/photo', { as: 'ben', upload: await upload(await jpeg()) });
  assert.equal(set.res.status, 303);
  assert.equal(set.location, '/profile?done=photo');
  assert.equal(t.moderator.avatars.length, 1, 'Claude looked first');
  const first = (await t.store.getPlayer(ben.id))!.avatar!;
  assert.ok(first);
  const large = (await t.photos.get(first, 'large', 'shown'))!;
  assert.deepEqual(
    [(await sharp(large).metadata()).width, (await sharp(large).metadata()).height],
    [512, 512],
    'cropped square'
  );
  const shown = await t.quiz('/profile?done=photo', { as: 'ben' });
  assert.ok(shown.html.includes('Your new photo is up.'));
  assert.ok(shown.html.includes(`${SITE}/p/${first}/thumb.jpg`));
  assert.ok(shown.html.includes('href="/profile/photo/remove"'));

  t.moderator.avatar = { verdict: 'hold', reason: 'That one can’t be your photo.' };
  const refused = await t.quiz('/profile/photo', { as: 'ben', upload: await upload(await jpeg('#b01c33')) });
  assert.equal(refused.res.status, 422);
  assert.ok(decoded(refused.html).includes('That one can’t be your photo.'));
  t.moderator.avatar = 'unavailable';
  const down = await t.quiz('/profile/photo', { as: 'ben', upload: await upload(await jpeg('#b01c33')) });
  assert.equal(down.res.status, 503);
  assert.ok(decoded(down.html).includes('Try again in a minute.'));
  assert.equal((await t.store.getPlayer(ben.id))!.avatar, first, 'neither changed it');

  const notPhoto = await t.quiz('/profile/photo', { as: 'ben', upload: await upload('hello', 'text/plain') });
  assert.equal(notPhoto.res.status, 400);
  assert.ok(notPhoto.html.includes('Send a JPEG, PNG or WebP photo.'));
  const none = await t.quiz('/profile/photo', { as: 'ben', upload: new FormData() });
  assert.equal(none.res.status, 400);
  assert.ok(none.html.includes('Choose a photo first.'));

  t.moderator.avatar = { verdict: 'ok', reason: '' };
  await t.quiz('/profile/photo', { as: 'ben', upload: await upload(await jpeg('#004c80')) });
  const second = (await t.store.getPlayer(ben.id))!.avatar!;
  assert.notEqual(second, first);
  assert.equal(await t.photos.get(first, 'large', 'shown'), undefined, 'the photo it replaced is gone');

  const asking = await t.quiz('/profile/photo/remove', { as: 'ben' });
  assert.equal(asking.res.status, 200);
  assert.ok(asking.html.includes('Remove your profile photo?'));
  assert.equal((await t.store.getPlayer(ben.id))!.avatar, second, 'asking changes nothing');
  const removed = await t.quiz('/profile/photo/remove', { as: 'ben', form: {} });
  assert.equal(removed.location, '/profile?done=removed');
  assert.equal((await t.store.getPlayer(ben.id))!.avatar, undefined);
  assert.equal(await t.photos.get(second, 'large', 'shown'), undefined);
  assert.equal((await t.quiz('/profile/photo/remove', { as: 'ben' })).location, '/profile', 'none left to remove');
});

test('sign out from the profile ends the session', async () => {
  const t = await setup();
  const out = await t.quiz('/signout', { as: 'ada', form: {} });
  assert.equal(out.location, '/');
  assert.match(out.res.headers.get('set-cookie')!, /rsm_quiz=;.*Max-Age=0/);
  assert.equal((await t.quiz('/profile', { as: 'ada' })).location, '/signin');
});

test('Delete my account: asked first, then everything goes, the newsletter too, and the cookie', async () => {
  const t = await setup();
  await t.newsletter.add(ada.email!);
  await t.store.setAvatar(ada.id, 'av-ada');
  const asking = await t.quiz('/profile/delete', { as: 'ada' });
  assert.equal(asking.res.status, 200);
  assert.ok(
    decoded(plain(asking.html)).includes(
      'This deletes your account and everything it made: the 2 signs you posted (with every way found on them)'
    )
  );
  assert.ok(await t.store.getPlayer(ada.id), 'asking changes nothing');
  assert.ok(
    decoded(plain((await t.quiz('/profile/delete', { as: 'ben' })).html)).includes(
      'everything it made: the ways you found, your name'
    )
  );

  const gone = await t.quiz('/profile/delete', { as: 'ada', form: {} });
  assert.equal(gone.res.status, 303);
  assert.equal(gone.location, '/deleted');
  assert.match(gone.res.headers.get('set-cookie')!, /rsm_quiz=;.*Max-Age=0/);
  assert.equal(await t.store.getPlayer(ada.id), undefined);
  assert.deepEqual(await t.store.allSigns(), [], 'her signs went with her');
  assert.ok(!t.newsletter.list.has(ada.email!), 'she left the newsletter');
  assert.ok(decoded((await t.quiz('/deleted')).html).includes('Your account is deleted'));
  assert.equal((await t.quiz('/next', { as: 'ada' })).location, '/signin', 'her session is gone');
});

test('every profile change must come from Quiz’s own pages', async () => {
  const t = await setup();
  await t.store.setAvatar(ada.id, 'av-ada');
  const evil = { as: 'ada', origin: 'https://evil.example' };
  for (const [path, init] of [
    ['/profile', { form: { name: 'Mallory', bio: 'gotcha' } }],
    ['/profile/photo', { upload: await upload(await jpeg()) }],
    ['/profile/photo/remove', { form: {} }],
    ['/profile/delete', { form: {} }]
  ] as const) {
    const refused = await t.quiz(path, { ...evil, ...init });
    assert.equal(refused.res.status, 400, path);
    assert.ok(decoded(refused.html).includes('That didn’t come from Quiz'), path);
    const bare = await t.quiz(path, { as: 'ada', origin: null, ...init });
    assert.equal(bare.res.status, 400, `${path} with no Origin`);
  }
  const still = (await t.store.getPlayer(ada.id))!;
  assert.equal(still.name, 'Ada');
  assert.equal(still.avatar, 'av-ada');
  assert.equal(t.moderator.avatars.length, 0);
});

test('/privacy and /support say Quiz has Delete my account too', async () => {
  const t = await setup();
  const privacy = decoded(plain(await (await t.app.request('/privacy')).text()));
  assert.ok(privacy.includes('Delete my account, in the app or on your profile in Quiz, removes them too.'));
  assert.ok(
    privacy.includes('Delete my account, in the app’s settings or on your profile in Quiz, deletes your account')
  );
  const support = decoded(plain(await (await t.app.request('/support')).text()));
  assert.ok(support.includes('In Quiz, choose your picture at the top of any page to open your profile'));
});
