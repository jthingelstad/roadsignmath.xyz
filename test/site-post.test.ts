// Posting a sign from the website (src/web/post.tsx), open as `siteSignInOpen` makes it and shut as
// deployed: signed out to sign in and back, the photo upload, the details' checks, "Posted
// already?", posted, held with the moderator's note, refused, unsolved, an idempotent retry, the
// Origin check, the pages that say you can post here, and the photo's EXIF read in the browser.
// Fictional players and signs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { productLog } from '../src/product.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, nowSeconds } from '../src/store/store.ts';
import { EXIF_JS } from '../src/web/post-script.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';
const S1 = '01JS0000000000000000000001';
const KEY = 'web_test_key_0001';

const jpeg = (color = '#808080') =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

async function setup(open: boolean | undefined) {
  const store = new MemoryStore();
  const photos = new MemoryPhotoStore();
  const mailer = new MemoryMailer();
  const moderator = new ScriptedModerator();
  const app = createApp({
    store,
    urls: { site: SITE, quiz: QUIZ },
    mailer,
    photos,
    moderator,
    newsletter: new MemoryNewsletter(),
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
  // Seven Twelve, 7 + 12 = 19, at 44.98, -93.27.
  await store.putSign(sign({ id: S1, title: 'Seven Twelve' }));

  const request = async (
    path: string,
    init: {
      form?: Record<string, string | string[]> | FormData;
      as?: string;
      cookie?: string;
      origin?: string | null;
      json?: boolean;
    } = {}
  ) => {
    const headers: Record<string, string> = {};
    const cookie = init.cookie ?? (init.as ? `rsm_session=${tokens[init.as]}` : undefined);
    if (cookie) headers.cookie = cookie;
    if (init.json) headers.accept = 'application/json';
    let body: string | FormData | undefined;
    if (init.form instanceof FormData) body = init.form;
    else if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const one of [v].flat()) params.append(k, one);
      body = params.toString();
    }
    if (body !== undefined && init.origin !== null) headers.origin = init.origin ?? SITE;
    const res = await app.request(path, { method: body !== undefined ? 'POST' : 'GET', headers, body });
    const type = res.headers.get('content-type') ?? '';
    const text = type.startsWith('image/') ? '' : await res.text();
    return { res, html: text, location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
  };

  /** Uploads a photo as the posting form's script does, and gives its id. */
  const upload = async (as = 'ada', bytes?: Buffer) => {
    const form = new FormData();
    form.append('go', 'photo');
    form.append('photo', new Blob([new Uint8Array(bytes ?? (await jpeg()))], { type: 'image/jpeg' }), 'photo.jpg');
    const up = await request('/post', { form, as, json: true });
    assert.equal(up.res.status, 200, up.html);
    return JSON.parse(up.html).id as string;
  };

  return { app, store, photos, mailer, moderator, request, upload, tokens };
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** A finished draft for the form: one photo, the numbers 7, 12 and 19, near Seven Twelve. */
const draft = (photo: string, more: Record<string, string> = {}): Record<string, string> => ({
  key: KEY,
  photos: photo,
  rows: '3',
  n0_value: '7',
  n0_text: 'Exit 7',
  n0_box: '0.1000,0.2000,0.1200,0.0800',
  n1_value: '12',
  n2_value: '19',
  title: 'Twelve Seven',
  caption: 'On the way north.',
  found_on: '2026-07-04',
  role: 'found',
  people: '0',
  label: 'Testville',
  state: 'MN',
  lat: '44.9801',
  lng: '-93.2702',
  ...more
});

test('shut, as deployed, /post is not there and no page says you can post here', async () => {
  const shut = await setup(false);
  for (const path of ['/post', '/post/done/01JS0000000000000000000001', '/post/photos/x/thumb.jpg']) {
    assert.equal((await shut.request(path, { as: 'ada' })).res.status, 404, path);
  }
  const posted = await shut.request('/post', { as: 'ada', form: { go: 'math' } });
  assert.equal(posted.res.status, 404);
  for (const path of ['/about', '/privacy', '/support', '/app']) {
    const page = await shut.request(path);
    assert.equal(page.res.status, 200, path);
    assert.ok(!page.html.includes('href="/post"'), path);
    assert.ok(!plain(page.html).includes('post a sign from this website'), path);
    assert.ok(!plain(page.html).includes('Signing in on this website'), path);
    assert.ok(!plain(page.html).includes('Can I post without the app?'), path);
  }
});

test('open, the pages say you can post here too, and the app stays the first answer on an iPhone', async () => {
  const t = await setup(true);
  const about = plain((await t.request('/about')).html);
  assert.ok(about.includes('You can post a sign from this website too: sign in and post one'));
  const privacy = plain((await t.request('/privacy')).html);
  assert.ok(privacy.includes('Signing in on this website'));
  assert.ok(privacy.includes('Road Sign Math never asks your browser where you are.'));
  const support = plain((await t.request('/support')).html);
  assert.ok(support.includes('Post from the web'));
  assert.ok(support.includes('On an iPhone, the app is the easier way.'));
  const app = await t.request('/app');
  assert.ok(plain(app.html).includes('Can I post without the app?'));
  assert.ok(app.html.indexOf('appstore') < app.html.indexOf('Can I post without the app?'), 'Get the app comes first');
  // /you offers it.
  assert.ok((await t.request('/you', { as: 'ada' })).html.includes('href="/post"'));
});

test('open, signed out, /post goes to sign in and comes back to the form', async () => {
  const t = await setup(true);
  const out = await t.request('/post');
  assert.equal(out.res.status, 303);
  assert.equal(out.location, '/signin?to=%2Fpost');
  assert.equal(out.res.headers.get('cache-control'), 'no-store');
  const outPost = await t.request('/post', { form: { go: 'math' } });
  assert.equal(outPost.location, '/signin?to=%2Fpost', 'a POST signed out changes nothing');

  const sent = await t.request('/signin', { form: { email: 'pat@example.com', to: '/post' } });
  assert.match(sent.location!, /^\/signin\/code\?l=[0-9A-Z]{26}&to=%2Fpost$/);
  const code = /code is (\d{6})/.exec(t.mailer.sent[0]!.subject)![1]!;
  const loginId = /l=([0-9A-Z]{26})/.exec(sent.location!)![1]!;
  const done = await t.request('/signin/code', { form: { login: loginId, code, to: '/post' } });
  assert.equal(done.location, '/signin/name?to=%2Fpost', 'a new player names themself first');
  const token = decodeURIComponent(
    /^rsm_session=([^;]+)/.exec(done.cookies.findLast((c) => c.startsWith('rsm_session='))!)![1]!
  );
  const cookie = `rsm_session=${token}`;
  // Without a name, the form waits for one.
  assert.equal((await t.request('/post', { cookie })).location, '/signin/name?to=%2Fpost');
  const named = await t.request('/signin/name', { form: { name: 'Pat', to: '/post' }, cookie });
  assert.equal(named.location, '/post');
  const form = await t.request('/post', { cookie });
  assert.equal(form.res.status, 200);
  assert.ok(form.html.includes('id="post-form"'));

  // Only /post is a place to come back to; anything else lands on /you.
  const elsewhere = await t.request('/signin?to=%2Fsigns%2Fseven-twelve', { cookie });
  assert.equal(elsewhere.location, '/you');
  assert.equal((await t.request('/signin?to=https%3A%2F%2Fevil.example', { cookie })).location, '/you');
});

test('open, the form: a fresh key, today’s date, no-store, and no GET changes anything', async () => {
  const t = await setup(true);
  const page = await t.request('/post', { as: 'ada' });
  assert.equal(page.res.status, 200);
  assert.equal(page.res.headers.get('cache-control'), 'no-store');
  assert.match(page.html, /name="key" value="web_[0-9a-f]{32}"/);
  assert.ok(page.html.includes('data-fresh="1"'));
  assert.ok(page.html.includes('enctype="multipart/form-data"'));
  assert.ok(plain(page.html).includes('Have an iPhone? Posting is easiest in the Road Sign Math app.'));
  // The keyboard's Enter goes on to the math: the first submit button is "math".
  const first = /<button[^>]*type="submit"[^>]*>/.exec(page.html)![0];
  assert.match(first, /value="math"/);
  assert.equal((await t.store.allSigns()).length, 1);
});

test('open, a photo goes up as the app’s do, only its poster sees it, and it waits in the draft', async () => {
  const t = await setup(true);
  const id = await t.upload();
  assert.match(id, /^[0-9a-z]{26}$/);
  assert.ok(await t.store.getUpload(ada.id, id));
  const mine = await t.request(`/post/photos/${id}/thumb.jpg`, { as: 'ada' });
  assert.equal(mine.res.status, 200);
  assert.equal(mine.res.headers.get('content-type'), 'image/jpeg');
  assert.equal(mine.res.headers.get('cache-control'), 'no-store');
  assert.equal((await t.request(`/post/photos/${id}/thumb.jpg`, { as: 'ben' })).res.status, 404);
  assert.equal((await t.request(`/post/photos/${id}/thumb.jpg`)).res.status, 404);

  // Without scripts: the photo comes with the form, and the form comes back with it.
  const form = new FormData();
  form.append('key', KEY);
  form.append('go', 'photo');
  form.append('title', 'Kept');
  form.append('photo', new Blob([new Uint8Array(await jpeg('#336699'))], { type: 'image/jpeg' }), 'b.jpg');
  const back = await t.request('/post', { form, as: 'ada' });
  assert.equal(back.res.status, 200);
  assert.ok(plain(back.html).includes('Photo added.'));
  assert.ok(back.html.includes('value="Kept"'), 'the rest of the draft is kept');
  assert.equal((back.html.match(/name="photos" value=/g) ?? []).length, 1);

  // A kind the server doesn't take is refused with its words, the draft kept.
  const heic = new FormData();
  heic.append('go', 'photo');
  heic.append('photo', new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'image/heic' }), 'a.heic');
  const refused = await t.request('/post', { form: heic, as: 'ada', json: true });
  assert.equal(refused.res.status, 400);
  assert.equal(JSON.parse(refused.html).error.message, 'Send a JPEG, PNG or WebP photo.');
});

test('open, the details are checked in the form’s words before the math', async () => {
  const t = await setup(true);
  const photo = await t.upload();
  const cases: [Record<string, string>, string][] = [
    [{ photos: '' }, 'Add a photo of the sign.'],
    [{ n0_value: '', n1_value: '', n2_value: '' }, 'Type the numbers on the sign.'],
    [{ title: '' }, 'Give the sign a title.'],
    [{ label: '' }, 'Say where the sign is: a town, a road or a place.'],
    [{ lng: '' }, 'Type both the latitude and the longitude, or neither.'],
    [{ n1_value: 'twelve' }, 'Number 2 must be a plain number, like "7" or "1.5".'],
    [{ lat: '95' }, 'The latitude is from -90 to 90.'],
    [{ found_on: '2999-01-01' }, 'The day found is a date like 2026-07-04, no later than today.']
  ];
  for (const [change, words] of cases) {
    const res = await t.request('/post', { as: 'ada', form: { ...draft(photo, change), go: 'math' } });
    assert.equal(res.res.status, 400, words);
    assert.ok(plain(res.html).includes(words), `${words} in ${plain(res.html).slice(0, 400)}`);
    assert.ok(res.html.includes('id="post-form"'), 'back on the details');
  }
  // More rows, and back, keep the draft.
  const more = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'more' } });
  assert.ok(more.html.includes('name="rows" value="4"'));
  assert.ok(more.html.includes('value="Twelve Seven"'));
  const dropped = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: `drop:${photo}` } });
  assert.ok(!dropped.html.includes(`name="photos" value="${photo}"`));
});

test('open, the math step: posted already? from the similar-signs lookup, then the keypad', async () => {
  const t = await setup(true);
  const photo = await t.upload();
  const page = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'math' } });
  assert.equal(page.res.status, 200);
  const text = plain(page.html);
  assert.ok(text.includes('Posted already?'));
  assert.ok(text.includes('Seven Twelve'));
  assert.ok(page.html.includes(`href="${QUIZ}/signs/seven-twelve"`), 'Find another way, to Quiz');
  assert.ok(text.includes('Find another way'));
  assert.ok(page.html.includes('id="solve"') && page.html.includes('id="pad"'), 'Quiz’s keypad');
  assert.ok(page.html.includes('data-v="12"'));
  assert.ok(page.html.includes('value="unsolved"'));
  assert.ok(text.includes('Posting agrees to the house rules.'));
  assert.ok(page.html.includes('href="/rules"'));
  // Far away, or with other numbers, nothing is offered.
  const far = await t.request('/post', {
    as: 'ada',
    form: { ...draft(photo, { lat: '40', lng: '-100' }), go: 'math' }
  });
  assert.ok(!plain(far.html).includes('Posted already?'));
  const none = await t.request('/post', { as: 'ada', form: { ...draft(photo, { lat: '', lng: '' }), go: 'math' } });
  assert.equal(none.res.status, 200);
  assert.ok(!plain(none.html).includes('Posted already?'));
});

test('open, posted: the sign is the app’s, marked from the site, and a retry makes no second one', async () => {
  const t = await setup(true);
  const lines: Record<string, unknown>[] = [];
  const write = productLog.write;
  productLog.write = (line) => void lines.push(line);
  try {
    const photo = await t.upload();
    const posted = await t.request('/post', {
      as: 'ada',
      form: {
        ...draft(photo, { role: 'took_photo', f0_who: 'Cy', f0_role: 'spotted', f1_who: '@ben', f1_role: 'found' }),
        go: 'post',
        text: '12 + 7 = 19'
      }
    });
    assert.equal(posted.res.status, 303, plain(posted.html).slice(0, 300));
    const id = /^\/post\/done\/([0-9A-Z]{26})$/.exec(posted.location!)![1]!;
    const made = (await t.store.getSign(id))!;
    assert.equal(made.visibility, 'shown');
    assert.equal(made.title, 'Twelve Seven');
    assert.equal(made.caption, 'On the way north.');
    assert.equal(made.firstWay?.text, '12 + 7 = 19');
    assert.deepEqual(made.numbers[0], { value: '7', text: 'Exit 7', box: [0.1, 0.2, 0.12, 0.08] });
    assert.deepEqual(made.place, { label: 'Testville', state: 'MN', lat: 44.9801, lng: -93.2702, approximate: false });
    assert.equal(made.foundOn, '2026-07-04');
    assert.deepEqual(
      made.finders.map((f) => [f.name, f.role]),
      [
        [ada.name, 'took_photo'],
        ['Cy', 'spotted'],
        [ben.name, 'found']
      ]
    );
    assert.equal(t.moderator.posts.length, 1, 'the moderator saw it as an app post');
    assert.ok(
      lines.some((l) => l.action === 'sign' && l.front === 'site' && l.outcome === 'shown' && l.solved === true)
    );

    const done = await t.request(posted.location!, { as: 'ada' });
    assert.ok(plain(done.html).includes('Twelve Seven is posted'));
    assert.ok(done.html.includes('href="/signs/twelve-seven"'));
    assert.ok(done.html.includes('rsm-post-draft'), 'the draft kept in the browser goes');
    assert.equal((await t.request(posted.location!, { as: 'ben' })).location, '/you', 'only its poster');

    // The same form sent again (a double tap, a retry) is the same sign.
    const again = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '12 + 7 = 19' } });
    assert.equal(again.location, posted.location);
    assert.equal((await t.store.allSigns()).length, 2);
    assert.equal(t.moderator.posts.length, 1);
  } finally {
    productLog.write = write;
  }
});

test('open, unsolved: posted without a way', async () => {
  const t = await setup(true);
  const photo = await t.upload();
  const posted = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'unsolved', text: 'ignored' } });
  assert.equal(posted.res.status, 303);
  const made = (await t.store.getSign(/([0-9A-Z]{26})$/.exec(posted.location!)![1]!))!;
  assert.equal(made.firstWay, undefined);
  assert.equal(made.wayCount, 0);
  assert.equal(made.finders.length, 1, 'found by the poster alone');
  assert.ok(plain((await t.request(posted.location!, { as: 'ada' })).html).includes('Unsolved, for now'));
});

test('open, held: the moderator’s note, and only the poster sees it', async () => {
  const t = await setup(true);
  t.moderator.post = { verdict: 'hold', reason: 'A person will look at this one first.', alt: [] };
  const photo = await t.upload();
  const posted = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '7 + 12 = 19' } });
  assert.equal(posted.res.status, 303);
  const done = await t.request(posted.location!, { as: 'ada' });
  const text = plain(done.html);
  assert.ok(text.includes('Twelve Seven is held for now'));
  assert.ok(text.includes('A person will look at this one first.'));
  assert.ok(text.includes('Only you can see it.'));
  assert.ok(!done.html.includes('href="/signs/twelve-seven"'));
  assert.equal((await t.store.getSign(/([0-9A-Z]{26})$/.exec(posted.location!)![1]!))!.visibility, 'held');
});

test('open, refused: math that doesn’t work, or a moderator who can’t look, keeps the draft and posts nothing', async () => {
  const t = await setup(true);
  const photo = await t.upload();
  const wrong = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '7 + 12 = 20' } });
  assert.equal(wrong.res.status, 400);
  assert.ok(wrong.html.includes('role="alert"'));
  assert.ok(wrong.html.includes('value="7 + 12 = 20"'), 'the math tried is back on the keypad');
  assert.ok(wrong.html.includes(`name="photos" value="${photo}"`), 'the draft rides on');
  const left = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '7 + 12 = 19 + 0' } });
  assert.equal(left.res.status, 400);

  t.moderator.post = 'unavailable';
  const busy = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '7 + 12 = 19' } });
  assert.equal(busy.res.status, 503);
  assert.ok(plain(busy.html).includes('Our moderator couldn’t look just now. Try again in a minute.'));
  assert.equal((await t.store.allSigns()).length, 1);
  // The same key works once the moderator is back.
  t.moderator.post = { verdict: 'ok', reason: '', alt: [] };
  const later = await t.request('/post', { as: 'ada', form: { ...draft(photo), go: 'post', text: '7 + 12 = 19' } });
  assert.equal(later.res.status, 303);
});

test('open, every POST must come from the site: another Origin uploads and posts nothing', async () => {
  const t = await setup(true);
  const photo = await t.upload();
  for (const origin of ['https://evil.example', QUIZ, null]) {
    const res = await t.request('/post', { as: 'ada', origin, form: { ...draft(photo), go: 'unsolved' } });
    assert.equal(res.res.status, 400, String(origin));
    assert.equal(res.res.headers.get('cache-control'), 'no-store');
    const form = new FormData();
    form.append('go', 'photo');
    form.append('photo', new Blob([new Uint8Array(await jpeg())], { type: 'image/jpeg' }), 'p.jpg');
    assert.equal((await t.request('/post', { as: 'ada', origin, form, json: true })).res.status, 400);
  }
  assert.equal((await t.store.allSigns()).length, 1);
});

test('the browser reads a photo’s place and day from its EXIF, and nothing from a photo without one', async () => {
  const withGps = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#777' } })
    .withExif({
      IFD2: { DateTimeOriginal: '2025:09:01 12:00:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '44/1 58/1 48/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '93/1 16/1 12/1'
      }
    })
    .jpeg()
    .toBuffer();
  const context: { window: { RSMExif?: { read(b: ArrayBuffer): Record<string, unknown> } } } = { window: {} };
  vm.runInNewContext(EXIF_JS, context);
  const read = (b: Buffer) =>
    context.window.RSMExif!.read(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
  assert.deepEqual({ ...read(withGps) }, { lat: 44.98, lng: -93.27, day: '2025-09-01' });
  assert.deepEqual({ ...read(await jpeg()) }, {});
  assert.deepEqual({ ...read(Buffer.from('not a photo at all')) }, {});
});
