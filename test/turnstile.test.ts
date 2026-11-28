// Cloudflare Turnstile on the website's and Quiz's sign-in form (src/auth/turnstile.ts,
// src/quiz/turnstile.ts). Cloudflare's siteverify is always a fake here: nothing reaches the
// network, and no live form is posted. Fictional addresses and made-up keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import {
  SITEVERIFY_URL,
  TURNSTILE_SITE_KEY,
  checkTurnstile,
  keptSecret,
  turnstileAllows,
  turnstileClient,
  turnstileLine,
  turnstileLog,
  turnstileMode,
  turnstileToken,
  widgetKey,
  type Fetch,
  type TurnstileConfig,
  type TurnstileMode
} from '../src/auth/turnstile.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { NOT_CHECKED, TOO_QUICK } from '../src/quiz/account.tsx';
import { SIGN_IN_PAUSE, formStamp } from '../src/quiz/pause.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';
const SECRET = 'made-up-secret';
const TOKEN = 'made-up-token';
const EMAIL = 'pat@example.com';

type Answer = 'pass' | 'fail' | 'hang' | 'http-500' | 'bad-secret';

/** A fake siteverify: answers as told, and keeps what it was asked. */
function fakeCloudflare(answer: Answer = 'pass') {
  const asked: { url: string; form: URLSearchParams }[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push({ url, form: new URLSearchParams(String(init.body)) });
    if (answer === 'hang')
      return new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason))
      );
    if (answer === 'http-500') return new Response('oops', { status: 500 });
    const body =
      answer === 'pass'
        ? { success: true, 'error-codes': [], hostname: 'example.test', action: 'signin-site' }
        : answer === 'fail'
          ? { success: false, 'error-codes': ['invalid-input-response'] }
          : { success: false, 'error-codes': ['invalid-input-secret'] };
    return Response.json(body);
  };
  return { fetch, asked };
}

const config = (
  mode: TurnstileMode,
  answer: Answer = 'pass',
  secret: string | null = SECRET
): TurnstileConfig & { asked: ReturnType<typeof fakeCloudflare>['asked'] } => {
  const cf = fakeCloudflare(answer);
  return {
    mode,
    siteKey: '1x00000000000000000000AA',
    secret: async () => secret ?? undefined,
    fetch: cf.fetch,
    timeoutMs: 50,
    asked: cf.asked
  };
};

// ---- The check on its own

test('siteverify is asked with the secret, the token and the viewer; its answer is the verdict', async () => {
  const c = config('observe', 'pass');
  const verdict = await checkTurnstile({ token: TOKEN, viewer: '192.0.2.1', config: c });
  assert.deepEqual(verdict, {
    result: 'pass',
    mode: 'observe',
    allowed: true,
    codes: [],
    hostname: 'example.test',
    action: 'signin-site'
  });
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0]!.url, SITEVERIFY_URL);
  assert.equal(c.asked[0]!.form.get('secret'), SECRET);
  assert.equal(c.asked[0]!.form.get('response'), TOKEN);
  assert.equal(c.asked[0]!.form.get('remoteip'), '192.0.2.1');
  const none = config('observe');
  await checkTurnstile({ token: TOKEN, viewer: 'unknown', config: none });
  assert.equal(none.asked[0]!.form.get('remoteip'), null, 'no address, none sent');
});

test('pass, fail, missing, unconfigured, error and off, in observe: nobody is refused', async () => {
  const cases: [string, TurnstileConfig, string, string[]][] = [
    ['fail', config('observe', 'fail'), TOKEN, ['invalid-input-response']],
    ['missing', config('observe'), '', []],
    ['unconfigured', config('observe', 'pass', null), TOKEN, []],
    ['unconfigured', config('observe', 'pass', ''), '', []],
    ['error', config('observe', 'hang'), TOKEN, ['TimeoutError']],
    ['error', config('observe', 'http-500'), TOKEN, ['http-500']],
    ['error', config('observe', 'bad-secret'), TOKEN, ['invalid-input-secret']],
    ['off', config('off'), TOKEN, []]
  ];
  for (const [result, c, token, codes] of cases) {
    const verdict = await checkTurnstile({ token, viewer: '192.0.2.1', config: c });
    assert.equal(verdict.result, result, `${result} ${codes}`);
    assert.deepEqual(verdict.codes, codes, result);
    assert.equal(verdict.allowed, true, `${result} goes ahead in ${c.mode}`);
  }
});

test('a timeout ends the wait at the timeout, and a secret that cannot be read is an error', async () => {
  const started = Date.now();
  const verdict = await checkTurnstile({ token: TOKEN, viewer: '', config: config('enforce', 'hang') });
  assert.equal(verdict.result, 'error');
  assert.equal(verdict.allowed, true, 'enforce fails open when Cloudflare can’t answer');
  assert.ok(Date.now() - started < 2000, 'it gave up at its own timeout');
  const broken: TurnstileConfig = {
    ...config('enforce'),
    secret: async () => {
      throw Object.assign(new Error('the secret, quoted'), { name: 'AccessDeniedException' });
    }
  };
  const lookup = await checkTurnstile({ token: TOKEN, viewer: '', config: broken });
  assert.deepEqual([lookup.result, lookup.codes, lookup.allowed], ['error', ['secret-AccessDeniedException'], true]);
});

test('enforce refuses only a missing token or one Cloudflare rejected', async () => {
  for (const [result, allowed] of [
    ['pass', true],
    ['fail', false],
    ['missing', false],
    ['error', true],
    ['unconfigured', true],
    ['off', true]
  ] as const) {
    assert.equal(turnstileAllows('enforce', result), allowed, result);
    assert.equal(turnstileAllows('observe', result), true, result);
  }
  const missing = await checkTurnstile({ token: '', viewer: '', config: config('enforce') });
  assert.deepEqual([missing.result, missing.allowed], ['missing', false]);
  const noSecret = await checkTurnstile({ token: '', viewer: '', config: config('enforce', 'pass', null) });
  assert.deepEqual([noSecret.result, noSecret.allowed], ['unconfigured', true], 'no secret yet: nobody is refused');
});

test('the mode is observe unless it names another, and off draws no widget', () => {
  assert.equal(turnstileMode(undefined), 'observe');
  assert.equal(turnstileMode('ENFORCE'), 'enforce');
  assert.equal(turnstileMode('nonsense'), 'observe');
  assert.equal(widgetKey(undefined), undefined);
  assert.equal(widgetKey(config('off')), undefined);
  assert.equal(widgetKey(config('observe')), '1x00000000000000000000AA');
  assert.equal(TURNSTILE_SITE_KEY, '0x4AAAAAAGXFwwVmY7mALKs3', 'the widget the owner made, public');
});

test('the page’s own words are kept small and never trusted', () => {
  const form = (fields: Record<string, string>) => (key: string) => fields[key] ?? '';
  assert.deepEqual(turnstileClient(form({ turnstile_reason: 'script-blocked', turnstile_wait_ms: '5003' })), {
    client_reason: 'script-blocked',
    client_wait_ms: 5003
  });
  assert.deepEqual(turnstileClient(form({ turnstile_reason: 'error:110200' })), { client_reason: 'error:110200' });
  assert.deepEqual(turnstileClient(form({ turnstile_reason: '<b>pat@example.com</b>', turnstile_wait_ms: '-4' })), {
    client_reason: 'other'
  });
  assert.deepEqual(turnstileClient(form({ turnstile_wait_ms: '99999999' })), { client_wait_ms: 600000 });
  assert.deepEqual(turnstileClient(form({})), {});
  assert.equal(turnstileToken(form({ turnstile_token: ' abc ' })), 'abc');
  assert.equal(turnstileToken(form({ 'cf-turnstile-response': 'def' })), 'def', 'Cloudflare’s own field too');
  assert.equal(turnstileToken(form({ turnstile_token: 'x'.repeat(3000) })).length, 2048);
});

test('the secret is read once an hour, a missing one every five minutes, an error not kept', async () => {
  let now = 0;
  let reads = 0;
  let value: string | undefined = undefined;
  let fails = false;
  const secret = keptSecret(
    async () => {
      reads++;
      if (fails) throw new Error('no');
      return value;
    },
    () => now
  );
  assert.equal(await secret(), undefined);
  now += 60_000;
  assert.equal(await secret(), undefined);
  assert.equal(reads, 1, 'missing, kept a while');
  now += 5 * 60_000;
  value = SECRET;
  assert.equal(await secret(), SECRET, 'asked again after five minutes');
  now += 30 * 60_000;
  assert.equal(await secret(), SECRET);
  assert.equal(reads, 2, 'found, kept an hour');
  now += 31 * 60_000;
  fails = true;
  await assert.rejects(secret());
  fails = false;
  assert.equal(await secret(), SECRET, 'an error is asked again at once');
  assert.equal(reads, 4);
});

// ---- On the sign-in form, website and Quiz

function setup(turnstile?: TurnstileConfig, signInPause = 0) {
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    quizOpen: true,
    siteSignInOpen: true,
    signInPause,
    ...(turnstile && { turnstile })
  });
  const request = async (front: 'site' | 'quiz', path: string, form?: Record<string, string>) => {
    const headers: Record<string, string> = { 'X-RSM-Front': front };
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = front === 'quiz' ? QUIZ : SITE;
      body = new URLSearchParams(form).toString();
    }
    const res = await app.request(path, { method: form ? 'POST' : 'GET', headers, body });
    return { res, html: await res.text(), location: res.headers.get('location') };
  };
  return { store, mailer, request };
}

/** The Turnstile lines written while `run` ran, and what `console.info` got (the pause's line). */
async function logged(run: () => Promise<void>) {
  const lines: Record<string, unknown>[] = [];
  const info: unknown[] = [];
  const write = turnstileLog.write;
  const consoleInfo = console.info;
  turnstileLog.write = (line) => void lines.push(line);
  console.info = (line: unknown) => void info.push(line);
  try {
    await run();
  } finally {
    turnstileLog.write = write;
    console.info = consoleInfo;
  }
  return { lines, info };
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const hiddenFields = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]])
  );

for (const front of ['site', 'quiz'] as const) {
  test(`${front}: with no Turnstile set up the form is as it was, and nothing is checked or logged`, async () => {
    const t = setup();
    const page = await t.request(front, '/signin');
    assert.doesNotMatch(page.html, /challenges\.cloudflare\.com|class="ts-slot"|name="turnstile_/);
    const { lines } = await logged(async () => {
      const sent = await t.request(front, '/signin', { email: EMAIL });
      assert.equal(sent.res.status, 303);
    });
    assert.deepEqual(lines, []);
    assert.equal(t.mailer.sent.length, 1);
  });

  test(`${front}: the form draws the widget and says no-script until its script runs`, async () => {
    const t = setup(config('observe'));
    const page = await t.request(front, '/signin');
    assert.match(page.html, /<form[^>]* data-turnstile=""/);
    assert.match(page.html, /class="ts-slot" data-sitekey="1x00000000000000000000AA"/);
    assert.match(page.html, new RegExp(`data-action="signin-${front}"`));
    assert.match(page.html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
    assert.deepEqual(
      { ...hiddenFields(page.html), at: undefined },
      { at: undefined, turnstile_token: '', turnstile_reason: 'no-script', turnstile_wait_ms: '' }
    );
    const off = setup(config('off'));
    assert.doesNotMatch(
      (await off.request(front, '/signin')).html,
      /class="ts-slot"|challenges\.cloudflare\.com/,
      'off: none'
    );
  });

  test(`${front}: observe checks and logs every post, refuses nobody, and never logs the token or address`, async () => {
    for (const [answer, token, result] of [
      ['pass', TOKEN, 'pass'],
      ['fail', TOKEN, 'fail'],
      ['pass', '', 'missing'],
      ['hang', TOKEN, 'error']
    ] as const) {
      const t = setup(config('observe', answer));
      const { lines } = await logged(async () => {
        const sent = await t.request(front, '/signin', {
          email: EMAIL,
          turnstile_token: token,
          turnstile_reason: token ? '' : 'script-blocked',
          turnstile_wait_ms: '812'
        });
        assert.equal(sent.res.status, 303, result);
      });
      assert.equal(t.mailer.sent.length, 1, `${result}: the email went`);
      assert.equal(lines.length, 1, 'one line per post');
      const line = lines[0]!;
      assert.equal(line.event, 'turnstile');
      assert.equal(line.result, result);
      assert.equal(line.mode, 'observe');
      assert.equal(line.allowed, true);
      assert.equal(line.front, front);
      assert.equal(line.client_wait_ms, 812);
      if (!token) assert.equal(line.client_reason, 'script-blocked');
      const text = JSON.stringify(line);
      assert.ok(!text.includes(TOKEN) && !text.includes(EMAIL) && !text.includes(SECRET), text);
    }
  });

  test(`${front}: with no secret yet every post logs unconfigured and goes ahead, even in enforce`, async () => {
    const c = config('enforce', 'pass', null);
    const t = setup(c);
    const { lines } = await logged(async () => {
      assert.equal(
        (await t.request(front, '/signin', { email: EMAIL, turnstile_reason: 'no-script' })).res.status,
        303
      );
      assert.equal((await t.request(front, '/signin', { email: EMAIL, turnstile_token: TOKEN })).res.status, 303);
    });
    assert.deepEqual(
      lines.map((l) => l.result),
      ['unconfigured', 'unconfigured']
    );
    assert.equal(lines[0]!.client_reason, 'no-script');
    assert.equal(c.asked.length, 0, 'Cloudflare is never asked without a secret');
    assert.equal(t.mailer.sent.length, 2);
  });

  test(`${front}: enforce refuses a missing or failed token with the form again, and lets pass and error through`, async () => {
    for (const [answer, token, status] of [
      ['pass', '', 403],
      ['fail', TOKEN, 403],
      ['pass', TOKEN, 303],
      ['hang', TOKEN, 303],
      ['http-500', TOKEN, 303]
    ] as const) {
      const t = setup(config('enforce', answer));
      const { lines } = await logged(async () => {
        const res = await t.request(front, '/signin', { email: EMAIL, turnstile_token: token });
        assert.equal(res.res.status, status, `${answer} ${token ? 'token' : 'none'}`);
        if (status === 403) {
          assert.ok(plain(res.html).includes(NOT_CHECKED), 'it says why');
          assert.match(res.html, new RegExp(`name="email"[^>]* value="${EMAIL}"`), 'what was typed is kept');
          assert.match(res.html, /class="ts-slot"/, 'with a new widget');
        }
      });
      assert.equal(t.mailer.sent.length, status === 303 ? 1 : 0);
      assert.equal(
        await t.store.bump('total', 3600, Math.floor(Date.now() / 1000)),
        status === 303 ? 2 : 1,
        'a refusal counts no try'
      );
      assert.equal(lines[0]!.allowed, status === 303);
      assert.equal(lines[0]!.mode, 'enforce');
    }
  });

  test(`${front}: Turnstile runs before the pause, so a quick post is logged too; a resend is not checked`, async () => {
    const c = config('observe');
    const t = setup(c, SIGN_IN_PAUSE);
    const page = await t.request(front, '/signin');
    const at = hiddenFields(page.html).at!;
    const { lines, info } = await logged(async () => {
      const quick = await t.request(front, '/signin', { email: EMAIL, at, turnstile_reason: 'no-script' });
      assert.equal(quick.res.status, 429);
      assert.ok(plain(quick.html).includes(TOO_QUICK));
    });
    assert.deepEqual(
      lines.map((l) => [l.result, l.client_reason]),
      [['missing', 'no-script']]
    );
    assert.deepEqual(info, [{ event: 'limited', limit: 'quick' }], 'then the pause, as before');
    assert.equal(t.mailer.sent.length, 0);

    const sent = await t.request(front, '/signin', {
      email: EMAIL,
      at: formStamp(Date.now() - 5000),
      turnstile_token: TOKEN
    });
    const login = /l=([0-9A-Z]{26})/.exec(sent.location!)![1]!;
    const resend = await logged(async () => {
      assert.equal((await t.request(front, '/signin', { again: '1', login })).res.status, 303);
    });
    assert.deepEqual(resend.lines, [], 'Send the email again follows a sign-in already checked');
    assert.equal(c.asked.length, 1);
    assert.equal(t.mailer.sent.length, 2);
  });
}

test('the line holds only small words and counts', () => {
  const line = turnstileLine(
    { result: 'fail', mode: 'observe', allowed: true, codes: ['invalid-input-response', 'timeout-or-duplicate'] },
    'site',
    { client_reason: 'no-widget', client_wait_ms: 40 }
  );
  assert.deepEqual(line, {
    event: 'turnstile',
    result: 'fail',
    mode: 'observe',
    allowed: true,
    front: 'site',
    codes: 'invalid-input-response,timeout-or-duplicate',
    client_reason: 'no-widget',
    client_wait_ms: 40
  });
});
