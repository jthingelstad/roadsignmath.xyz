// Reports from the website (src/web/report.tsx), open (as deployed since 2026-11-12) and shut by
// `siteSignInOpen`: the links on the cached sign and player pages, Report this sign (reported, hidden or
// kept, already, your own sign, the day's limit, a moderator who can't look), Report a duplicate
// (the similar signs, an address typed, no JavaScript), Report this player, signed out to sign in
// and back by the code, the email's link and the name page, no open redirect, the Origin check, and
// the 404s a page gives. Fictional players and signs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { LIMITS } from '../src/api/contract.ts';
import { PAGE_CACHE } from '../src/edge-cache.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { productLog } from '../src/product.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { reportBackTo, signNamed } from '../src/web/report.tsx';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';
const OWNER = 'owner@example.test';
const S1 = '01JS0000000000000000000001';
const S2 = '01JS0000000000000000000002';
const S3 = '01JS0000000000000000000003';
const S4 = '01JS0000000000000000000004';

async function setup(open: boolean | undefined) {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: SITE, quiz: QUIZ },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator,
    newsletter: new MemoryNewsletter(),
    clientIp: () => '192.0.2.1',
    feedbackTo: OWNER,
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
  // Ada's Seven Twelve, and Ben's Twelve Seven a few hundred feet away with the same numbers.
  await store.putSign(sign({ id: S1, title: 'Seven Twelve' }));
  await store.putSign(
    sign({
      id: S2,
      title: 'Twelve Seven',
      place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.981, lng: -93.271, approximate: true },
      postedBy: ben.id,
      finders: [{ playerId: ben.id, name: ben.name, role: 'found' }],
      firstWay: { text: '12 + 7 = 19', value: '19', playerId: ben.id }
    })
  );
  // A sign with no pin, and one held.
  await store.putSign(
    sign({
      id: S3,
      title: 'No Pin',
      place: { label: 'Somewhere', approximate: false },
      postedBy: ben.id,
      finders: [{ playerId: ben.id, name: ben.name, role: 'found' }]
    })
  );
  await store.putSign(sign({ id: S4, title: 'Held One', visibility: 'held', postedBy: ben.id }));

  const request = async (
    path: string,
    init: { form?: Record<string, string>; as?: string; cookie?: string; origin?: string | null } = {}
  ) => {
    const headers: Record<string, string> = {};
    const cookie = init.cookie ?? (init.as ? `rsm_session=${tokens[init.as]}` : undefined);
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
      if (init.origin !== null) headers.origin = init.origin ?? SITE;
    }
    const res = await app.request(path, { method: body !== undefined ? 'POST' : 'GET', headers, body });
    return { res, html: await res.text(), location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
  };
  const reports = () => mailer.sent.filter((m) => m.to === OWNER);
  return { app, store, mailer, moderator, request, reports };
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** Collects the product lines a body of work writes. */
async function productLines(work: () => Promise<void>) {
  const lines: Record<string, unknown>[] = [];
  const write = productLog.write;
  productLog.write = (line) => void lines.push(line);
  try {
    await work();
  } finally {
    productLog.write = write;
  }
  return lines;
}

const FORMS = [
  '/you/report/sign/twelve-seven',
  '/you/report/sign/twelve-seven/done',
  '/you/report/duplicate/twelve-seven',
  '/you/report/duplicate/twelve-seven/done',
  '/you/report/player/ben',
  '/you/report/player/ben/done'
];

test('shut, the pages carry no report links and the forms are not there', async () => {
  const shut = await setup(false);
  for (const path of ['/signs/twelve-seven', '/players/ben']) {
    const page = await shut.request(path);
    assert.equal(page.res.status, 200, path);
    assert.ok(!page.html.includes('/you/report/'), path);
    assert.ok(!page.html.includes('.reports'), `${path}: not even the links' style`);
    assert.ok(!plain(page.html).includes('Report'), path);
  }
  for (const path of FORMS) {
    assert.equal((await shut.request(path, { as: 'ada' })).res.status, 404, path);
  }
  assert.equal(
    (await shut.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: '' } })).res.status,
    404
  );
  // Shut, `/signin` is only the iPhone app's landing, which goes nowhere.
  assert.equal((await shut.request('/signin?to=%2Fyou%2Freport%2Fsign%2Ftwelve-seven', { as: 'ada' })).location, null);
});

test('open, the sign and player pages link the forms and stay cached, the same for everyone', async () => {
  const t = await setup(true);
  for (const as of [undefined, 'ada']) {
    const page = await t.request('/signs/twelve-seven', { as });
    assert.equal(page.res.status, 200);
    assert.equal(page.res.headers.get('cache-control'), PAGE_CACHE);
    assert.deepEqual(page.cookies, [], 'no cookie on a cached page');
    assert.ok(page.html.includes('<a href="/you/report/sign/twelve-seven">Report this sign</a>'));
    assert.ok(page.html.includes('<a href="/you/report/duplicate/twelve-seven">Report a duplicate</a>'));
    const player = await t.request('/players/ben', { as });
    assert.equal(player.res.headers.get('cache-control'), PAGE_CACHE);
    assert.deepEqual(player.cookies, []);
    assert.ok(player.html.includes('<a href="/you/report/player/ben">Report this player</a>'));
  }
  // The same page signed in and out: nothing per person.
  assert.equal(
    (await t.request('/signs/twelve-seven')).html,
    (await t.request('/signs/twelve-seven', { as: 'ben' })).html
  );
});

test('open, the forms are never cached, and no GET changes anything', async () => {
  const t = await setup(true);
  for (const path of [
    '/you/report/sign/twelve-seven',
    '/you/report/duplicate/twelve-seven',
    '/you/report/player/ben'
  ]) {
    const page = await t.request(path, { as: 'ada' });
    assert.equal(page.res.status, 200, path);
    assert.equal(page.res.headers.get('cache-control'), 'no-store', path);
    assert.match(page.html, /<form method="post"/, path);
  }
  assert.equal(t.moderator.reports.length, 0);
  assert.equal(t.reports().length, 0);
  assert.equal(await t.store.getReport(S2, ada.id), undefined);
  // A done page with nothing reported goes back to the form.
  assert.equal(
    (await t.request('/you/report/sign/twelve-seven/done', { as: 'ada' })).location,
    '/you/report/sign/twelve-seven'
  );
  assert.equal((await t.request('/you/report/player/ben/done', { as: 'ada' })).location, '/you/report/player/ben');
});

test('open, Report this sign: kept, with the app’s words, the owner told, and the product line from the site', async () => {
  const t = await setup(true);
  const form = plain((await t.request('/you/report/sign/twelve-seven', { as: 'ada' })).html);
  assert.ok(form.includes('Report this sign'));
  assert.ok(
    form.includes(
      'Is this sign inappropriate? The moderator takes another look, and if it agrees, the sign comes down for everyone.'
    )
  );
  assert.ok(form.includes('Anything to add?'));
  assert.ok(form.includes('Report as inappropriate'));
  let sent!: Awaited<ReturnType<typeof t.request>>;
  const lines = await productLines(async () => {
    sent = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: '  Not a   real sign. ' } });
  });
  assert.equal(sent.res.status, 303);
  assert.equal(sent.location, '/you/report/sign/twelve-seven/done');
  assert.equal(t.moderator.reports[0]!.reason, 'Inappropriate: Not a real sign.', 'the app’s reason');
  assert.ok(lines.some((l) => l.action === 'report' && l.front === 'site' && l.outcome === 'kept'));
  assert.equal(t.reports().length, 1);
  assert.match(t.reports()[0]!.subject, /report: Twelve Seven \(kept\)/);
  const done = await t.request(sent.location!, { as: 'ada' });
  assert.equal(done.res.headers.get('cache-control'), 'no-store');
  const words = plain(done.html);
  assert.ok(words.includes('It stays up'));
  assert.ok(words.includes('The moderator looked again and kept it. Thanks for telling us.'));
  assert.ok(words.includes('The moderator’s note'));
  assert.ok(words.includes('Nothing wrong with it.'));
  assert.ok(!words.includes('You reported this sign already.'));

  // Again: the first answer, no second look, no second email, no limit counted.
  const again = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: 'Again' } });
  assert.equal(again.location, '/you/report/sign/twelve-seven/done');
  assert.equal(t.moderator.reports.length, 1);
  assert.equal(t.reports().length, 1);
  const form2 = plain((await t.request('/you/report/sign/twelve-seven', { as: 'ada' })).html);
  assert.ok(form2.includes('You reported this sign already.'));
  assert.ok(form2.includes('It stays up'));
  assert.ok(!form2.includes('Report as inappropriate'));
  assert.equal(await t.store.bump(`reports:${ada.id}`, 86_400, nowSeconds()), 2, 'one counted before this');
});

test('open, Report this sign: hidden, it comes down, and the reporter still sees what became of it', async () => {
  const t = await setup(true);
  t.moderator.report = { verdict: 'hide', reason: 'It isn’t a road sign.' };
  const sent = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: '' } });
  assert.equal(sent.location, '/you/report/sign/twelve-seven/done');
  assert.equal(t.moderator.reports[0]!.reason, 'Inappropriate');
  assert.equal((await t.store.getSign(S2))!.visibility, 'hidden');
  const done = await t.request(sent.location!, { as: 'ada' });
  const words = plain(done.html);
  assert.ok(words.includes('It’s down'));
  assert.ok(words.includes('Thanks for telling us. It’s off the feed, the map and the website.'));
  assert.ok(words.includes('It isn’t a road sign.'));
  assert.ok(done.html.includes('href="/"'), 'Done goes Home, the page is gone');
  assert.ok(!done.html.includes('href="/signs/twelve-seven"'));
  // Everyone else gets the 404 the page gives.
  assert.equal((await t.request('/signs/twelve-seven')).res.status, 404);
  for (const path of ['/you/report/sign/twelve-seven', '/you/report/duplicate/twelve-seven']) {
    assert.equal((await t.request(path, { as: 'ben' })).res.status, 404, path);
  }
  assert.equal((await t.request('/you/report/sign/twelve-seven', { as: 'ben', form: { note: '' } })).res.status, 404);
});

test('open, Report this sign: your own sign is refused, a long note is refused, and nothing is sent', async () => {
  const t = await setup(true);
  const own = await t.request('/you/report/sign/twelve-seven', { as: 'ben' });
  assert.equal(own.res.status, 200);
  assert.ok(plain(own.html).includes('You can’t report your own sign.'));
  assert.ok(!own.html.includes('<form method="post"'));
  const posted = await t.request('/you/report/sign/twelve-seven', { as: 'ben', form: { note: '' } });
  assert.equal(posted.res.status, 400);
  assert.ok(plain(posted.html).includes('You can’t report your own sign.'));
  const long = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: 'x'.repeat(286) } });
  assert.equal(long.res.status, 400);
  assert.ok(plain(long.html).includes('Your note is at most 285 characters.'));
  assert.ok(long.html.includes('x'.repeat(286)), 'the note stays in the form');
  assert.equal(t.moderator.reports.length, 0);
  assert.equal(t.reports().length, 0);
});

test('open, Report this sign: the day’s limit and a moderator who can’t look change nothing', async () => {
  const t = await setup(true);
  t.moderator.report = 'unavailable';
  const down = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: 'Odd' } });
  assert.equal(down.res.status, 503);
  assert.ok(plain(down.html).includes('Our moderator couldn’t look just now. Try again in a minute.'));
  assert.ok(down.html.includes('>Odd</textarea>'), 'the note stays');
  assert.equal(await t.store.getReport(S2, ada.id), undefined);
  assert.equal((await t.store.getSign(S2))!.visibility, 'shown');
  assert.equal(t.reports().length, 0);

  t.moderator.report = { verdict: 'keep', reason: 'Fine.' };
  for (let i = 0; i < LIMITS.reportsADay; i++) await t.store.bump(`reports:${ada.id}`, 86_400, nowSeconds());
  const limited = await t.request('/you/report/sign/twelve-seven', { as: 'ada', form: { note: '' } });
  assert.equal(limited.res.status, 429);
  assert.ok(plain(limited.html).includes('Too many reports today. Try again tomorrow.'));
  assert.equal(await t.store.getReport(S2, ada.id), undefined);
  // The same limit holds a duplicate and a player report.
  const dup = await t.request('/you/report/duplicate/twelve-seven', { as: 'ada', form: { same_as: 'seven-twelve' } });
  assert.equal(dup.res.status, 429);
  const player = await t.request('/you/report/player/ben', { as: 'ada', form: { note: '' } });
  assert.equal(player.res.status, 429);
  assert.equal(t.reports().length, 0);
});

test('open, Report a duplicate: the similar signs to pick, an address typed instead, kept and told', async () => {
  const t = await setup(true);
  const form = await t.request('/you/report/duplicate/twelve-seven', { as: 'ada' });
  const words = plain(form.html);
  assert.ok(
    words.includes(
      'Is this the same road sign as one posted before? Pick that one. Neither sign changes; your report is kept for later.'
    )
  );
  assert.ok(words.includes('The same sign as'));
  assert.ok(
    form.html.includes('type="radio" name="same_as" value="seven-twelve"'),
    'Seven Twelve is near, same numbers'
  );
  assert.ok(!form.html.includes('value="no-pin"'), 'a sign with no pin is not near');
  assert.ok(!form.html.includes('value="held-one"'), 'a held sign is not offered');
  assert.ok(!form.html.includes('value="twelve-seven"'), 'not itself');
  assert.ok(words.includes('mi away, found by Ada, Jan 2026'), 'the dots, as a screen reader hears them');

  // Nothing picked or typed.
  const none = await t.request('/you/report/duplicate/twelve-seven', { as: 'ada', form: { note: '' } });
  assert.equal(none.res.status, 400);
  assert.ok(plain(none.html).includes('Pick the sign it’s the same as, or give its address.'));
  // A name no sign has.
  const nope = await t.request('/you/report/duplicate/twelve-seven', { as: 'ada', form: { other: 'held-one' } });
  assert.equal(nope.res.status, 400);
  assert.ok(plain(nope.html).includes('No sign has that address or name. Check it and try again.'));
  assert.ok(nope.html.includes('value="held-one"'), 'what was typed stays');
  // Itself.
  const self = await t.request('/you/report/duplicate/twelve-seven', { as: 'ada', form: { other: 'twelve-seven' } });
  assert.equal(self.res.status, 400);

  // Picked, as without JavaScript: a plain form post.
  let sent!: Awaited<ReturnType<typeof t.request>>;
  const lines = await productLines(async () => {
    sent = await t.request('/you/report/duplicate/twelve-seven', {
      as: 'ada',
      form: { same_as: 'seven-twelve', note: 'Same exit.' }
    });
  });
  assert.equal(sent.location, '/you/report/duplicate/twelve-seven/done');
  const kept = (await t.store.getDuplicate(S2, ada.id))!;
  assert.equal(kept.sameAs, S1);
  assert.equal(kept.note, 'Same exit.');
  assert.ok(lines.some((l) => l.action === 'duplicate' && l.front === 'site'));
  assert.equal(t.reports().length, 1);
  assert.match(t.reports()[0]!.subject, /duplicate: Twelve Seven/);
  assert.equal(t.moderator.reports.length, 0, 'a duplicate never goes to the moderator');
  const done = plain((await t.request(sent.location!, { as: 'ada' })).html);
  assert.ok(done.includes('Thanks, it’s noted'));
  assert.ok(done.includes('Both signs stay as they are. Your report is kept for later.'));
  assert.equal((await t.store.getSign(S2))!.visibility, 'shown');

  // The address typed wins over a pick, as a full page address.
  const typed = await t.request('/you/report/duplicate/twelve-seven', {
    as: 'ada',
    form: { same_as: 'seven-twelve', other: `${SITE}/signs/no-pin` }
  });
  assert.equal(typed.location, '/you/report/duplicate/twelve-seven/done');
  assert.equal((await t.store.getDuplicate(S2, ada.id))!.sameAs, S3, 'another replaces the first');
});

test('open, Report a duplicate: a sign with no pin says so, and your own sign can be reported', async () => {
  const t = await setup(true);
  const form = await t.request('/you/report/duplicate/no-pin', { as: 'ben' });
  assert.equal(form.res.status, 200);
  assert.ok(
    plain(form.html).includes('This sign has no pin on the map, so there are no signs near it to choose from.')
  );
  assert.ok(!form.html.includes('type="radio"'));
  const sent = await t.request('/you/report/duplicate/no-pin', { as: 'ben', form: { other: 'Seven Twelve' } });
  assert.equal(sent.location, '/you/report/duplicate/no-pin/done', 'a title only one sign has');
  assert.equal((await t.store.getDuplicate(S3, ben.id))!.sameAs, S1);
});

test('open, Report this player: sent to the owner, once, never yourself, nothing hidden', async () => {
  const t = await setup(true);
  const form = plain((await t.request('/you/report/player/ben', { as: 'ada' })).html);
  assert.ok(
    form.includes(
      'Is something on Ben’s page inappropriate? Your report goes to Jamie, who runs Road Sign Math, with your name. Nothing comes down on its own.'
    )
  );
  let sent!: Awaited<ReturnType<typeof t.request>>;
  const lines = await productLines(async () => {
    sent = await t.request('/you/report/player/ben', { as: 'ada', form: { note: 'Rude bio.' } });
  });
  assert.equal(sent.location, '/you/report/player/ben/done');
  assert.equal((await t.store.getPlayerReport(ben.id, ada.id))!.reason, 'Inappropriate: Rude bio.');
  assert.ok(lines.some((l) => l.action === 'player-report' && l.front === 'site'));
  assert.equal(t.reports().length, 1);
  assert.match(t.reports()[0]!.subject, /player report: Ben/);
  const done = plain((await t.request(sent.location!, { as: 'ada' })).html);
  assert.ok(done.includes('Report sent'));
  assert.ok(done.includes('Thanks for telling us. It’s on its way to Jamie.'));
  // A repeat sends nothing.
  await t.request('/you/report/player/ben', { as: 'ada', form: { note: 'Again' } });
  assert.equal(t.reports().length, 1);
  assert.ok(
    plain((await t.request('/you/report/player/ben', { as: 'ada' })).html).includes('You reported Ben already.')
  );
  assert.equal((await t.request('/players/ben')).res.status, 200, 'nothing comes down');

  // Yourself.
  const me = await t.request('/you/report/player/ben', { as: 'ben' });
  assert.ok(plain(me.html).includes('You can’t report yourself.'));
  assert.ok(!me.html.includes('<form method="post"'));
  const mePost = await t.request('/you/report/player/ben', { as: 'ben', form: { note: '' } });
  assert.equal(mePost.res.status, 400);
  assert.equal(t.reports().length, 1);
});

test('open, a sign or player with no page here has no form either', async () => {
  const t = await setup(true);
  await addPlayer(t.store, {
    id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
    handle: 'cy',
    name: 'Cy',
    avatarColor: '#004C80',
    createdAt: '2026-01-03T00:00:00.000Z'
  });
  for (const path of [
    '/you/report/sign/held-one',
    '/you/report/duplicate/held-one',
    '/you/report/sign/no-such-sign',
    '/you/report/player/cy',
    '/you/report/player/nobody',
    '/you/report/sign/Twelve-Seven',
    '/you/report/sign/twelve--seven',
    `/you/report/sign/${'a'.repeat(81)}`,
    '/you/report/player/01JBBBBBBBBBBBBBBBBBBBBBBB'
  ]) {
    assert.equal((await t.request(path, { as: 'ada' })).res.status, 404, path);
  }
  assert.equal((await t.request('/you/report/player/cy', { as: 'ada', form: { note: '' } })).res.status, 404);
  // A sign by a player you blocked is not there for you.
  await t.store.putBlock({ playerId: ada.id, blockedId: ben.id, createdAt: '2026-01-05T00:00:00.000Z' });
  assert.equal((await t.request('/you/report/sign/twelve-seven', { as: 'ada' })).res.status, 404);
  assert.equal(
    (await t.request('/you/report/duplicate/twelve-seven', { as: 'ada', form: { same_as: 'seven-twelve' } })).res
      .status,
    404
  );
  // ...and a duplicate can't name it.
  const named = await t.request('/you/report/duplicate/seven-twelve', { as: 'ada', form: { other: 'twelve-seven' } });
  assert.equal(named.res.status, 400);
});

test('open, every POST must come from the site', async () => {
  const t = await setup(true);
  for (const [path, form] of [
    ['/you/report/sign/twelve-seven', { note: '' }],
    ['/you/report/duplicate/twelve-seven', { same_as: 'seven-twelve' }],
    ['/you/report/player/ben', { note: '' }]
  ] as const) {
    for (const origin of ['https://evil.example', QUIZ, null]) {
      const res = await t.request(path, { as: 'ada', form, origin });
      assert.equal(res.res.status, 400, `${path} from ${origin}`);
    }
  }
  assert.equal(t.moderator.reports.length, 0);
  assert.equal(await t.store.getDuplicate(S2, ada.id), undefined);
  assert.equal(await t.store.getPlayerReport(ben.id, ada.id), undefined);
  assert.equal(t.reports().length, 0);
});

test('open, signed out: to sign in by the code, the name page and the email’s link, and back on the form', async () => {
  const t = await setup(true);
  for (const path of [
    '/you/report/sign/twelve-seven',
    '/you/report/duplicate/twelve-seven',
    '/you/report/player/ben'
  ]) {
    const out = await t.request(path);
    assert.equal(out.res.status, 303, path);
    assert.equal(out.location, `/signin?to=${encodeURIComponent(path)}`);
    assert.equal(out.res.headers.get('cache-control'), 'no-store');
    const post = await t.request(path, { form: { note: '' } });
    assert.equal(post.location, `/signin?to=${encodeURIComponent(path)}`, 'a POST signed out changes nothing');
  }
  assert.equal(t.moderator.reports.length, 0);

  // The sign-in page keeps where to go.
  const to = '/you/report/sign/twelve-seven';
  const signin = await t.request(`/signin?to=${encodeURIComponent(to)}`);
  assert.ok(signin.html.includes(`name="to" value="${to}"`));

  // By the code, a new player names themself first, then lands on the form.
  const sent = await t.request('/signin', { form: { email: 'pat@example.com', to } });
  assert.equal(sent.location!.endsWith(`&to=${encodeURIComponent(to)}`), true);
  const mail = t.mailer.sent.at(-1)!;
  const code = /code is (\d{6})/.exec(mail.subject)![1]!;
  const loginId = new URL(sent.location!, SITE).searchParams.get('l')!;
  const done = await t.request('/signin/code', { form: { login: loginId, code, to } });
  assert.equal(done.location, `/signin/name?to=${encodeURIComponent(to)}`);
  const cookie = `rsm_session=${decodeURIComponent(
    /^rsm_session=([^;]+)/.exec(done.cookies.findLast((c) => c.startsWith('rsm_session='))!)![1]!
  )}`;
  assert.equal((await t.request(to, { cookie })).location, `/signin/name?to=${encodeURIComponent(to)}`);
  const named = await t.request('/signin/name', { form: { name: 'Pat', to }, cookie });
  assert.equal(named.location, to);
  const form = await t.request(to, { cookie });
  assert.equal(form.res.status, 200);
  assert.ok(plain(form.html).includes('Report as inappropriate'));

  // By the email's link: its `to` is the form, encoded, and it lands there.
  const player = '/you/report/player/ben';
  await t.request('/signin', { form: { email: 'ada@example.com', to: player } });
  const text = t.mailer.sent.at(-1)!.text;
  const link = new URL(/https:\/\/\S+\/signin\/link\?\S+/.exec(text)![0]);
  assert.equal(link.searchParams.get('to'), player);
  assert.ok(link.search.includes(`to=${encodeURIComponent(player)}`), 'encoded in the link');
  const landing = await t.request(`${link.pathname}${link.search}`);
  assert.equal(landing.res.status, 200);
  const used = await t.request('/signin/link', {
    form: { login: link.searchParams.get('l')!, token: link.searchParams.get('t')!, to: player }
  });
  assert.equal(used.location, player);
});

test('the sign-in takes only a report form’s own path back, never anywhere else', async () => {
  for (const ok of ['/you/report/sign/twelve-seven', '/you/report/duplicate/a-1', '/you/report/player/ben']) {
    assert.equal(reportBackTo(ok), ok);
  }
  for (const bad of [
    undefined,
    '',
    '/you/report/sign/',
    '/you/report/sign/twelve-seven/done',
    '/you/report/sign/Twelve-Seven',
    '/you/report/sign/-x',
    '/you/report/sign/x-',
    '/you/report/sign/a--b',
    `/you/report/sign/${'a'.repeat(81)}`,
    '/you/report/sign/a/../../evil',
    '/you/report/sign/a%2F..',
    '/you/report/hide/x',
    '//evil.example/you/report/sign/x',
    'https://evil.example/you/report/sign/x',
    '/you/report/sign/x?y=1',
    '/you/report/sign/x#y',
    '/you/report/sign/x\n',
    ' /you/report/sign/x'
  ]) {
    assert.equal(reportBackTo(bad), undefined, String(bad));
  }
});

test('open, a `to` that is not a report form lands on /you', async () => {
  const t = await setup(true);
  for (const to of [
    'https://evil.example/you/report/sign/twelve-seven',
    '//evil.example/you/report/sign/twelve-seven',
    '/you/report/sign/twelve-seven/../../../evil',
    '/you/report/sign/Twelve-Seven'
  ]) {
    const page = await t.request(`/signin?to=${encodeURIComponent(to)}`, { as: 'ada' });
    assert.equal(page.location, '/you', to);
  }
  assert.equal(
    (await t.request(`/signin?to=${encodeURIComponent('/you/report/player/ben')}`, { as: 'ada' })).location,
    '/you/report/player/ben'
  );
});

test('a duplicate’s other sign is found by its address, slug, id or a title only one sign has', () => {
  const signs = [
    sign({ id: S1, title: 'Seven Twelve' }),
    sign({ id: S2, title: 'Twelve Seven' }),
    sign({ id: S3, title: 'Same Name', slug: 'same-name' }),
    sign({ id: S4, title: 'Same Name', slug: 'same-name-2' })
  ];
  assert.equal(signNamed(signs, 'https://roadsignmath.xyz/signs/seven-twelve')?.id, S1);
  assert.equal(signNamed(signs, 'roadsignmath.xyz/signs/seven-twelve?x=1#y')?.id, S1);
  assert.equal(signNamed(signs, '/signs/twelve-seven/')?.id, S2);
  assert.equal(signNamed(signs, 'twelve-seven')?.id, S2);
  assert.equal(signNamed(signs, S2.toLowerCase())?.id, S2);
  assert.equal(signNamed(signs, '  twelve seven ')?.id, S2);
  assert.equal(signNamed(signs, 'same-name-2')?.id, S4);
  assert.equal(signNamed(signs, 'Same Name'), undefined, 'two signs have that title');
  assert.equal(signNamed(signs, 'nothing'), undefined);
  assert.equal(signNamed(signs, ''), undefined);
  assert.equal(signNamed(signs, 'http://[bad'), undefined);
});
