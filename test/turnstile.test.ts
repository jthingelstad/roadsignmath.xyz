// Cloudflare Turnstile on the website's and Quiz's sign-in form (src/auth/turnstile.ts,
// src/quiz/turnstile.ts). Cloudflare's siteverify is always a fake here: nothing reaches the
// network, and no live form is posted. Fictional addresses and made-up keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
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
  turnstileAction,
  widgetHostnames,
  widgetKey,
  type Fetch,
  type TurnstileConfig,
  type TurnstileExpect,
  type TurnstileMode
} from '../src/auth/turnstile.ts';
import { FINAL_CODES, RETRY_INTERVAL_MS, TURNSTILE_JS } from '../src/quiz/turnstile.ts';
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

type Answer = 'pass' | 'fail' | 'hang' | 'http-500' | 'bad-secret' | 'internal';
/** Where and for what a passing token says it was made. */
type Made = { hostname?: string; action?: string };

/** What the tests' sign-in form expects: the made-up site's hostnames, and the website's action. */
const EXPECT: TurnstileExpect = { hostnames: widgetHostnames(SITE, QUIZ), action: 'signin-site' };

/** A fake siteverify: answers as told, and keeps what it was asked. */
function fakeCloudflare(answer: Answer = 'pass', made: Made = { hostname: 'example.test', action: 'signin-site' }) {
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
        ? { success: true, 'error-codes': [], ...made }
        : answer === 'fail'
          ? { success: false, 'error-codes': ['invalid-input-response'] }
          : answer === 'internal'
            ? { success: false, 'error-codes': ['internal-error'] }
            : { success: false, 'error-codes': ['invalid-input-secret'] };
    return Response.json(body);
  };
  return { fetch, asked };
}

const config = (
  mode: TurnstileMode,
  answer: Answer = 'pass',
  secret: string | null = SECRET,
  made?: Made
): TurnstileConfig & { asked: ReturnType<typeof fakeCloudflare>['asked'] } => {
  const cf = fakeCloudflare(answer, made);
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
  const verdict = await checkTurnstile({ token: TOKEN, viewer: '192.0.2.1', config: c, expect: EXPECT });
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
  await checkTurnstile({ token: TOKEN, viewer: 'unknown', config: none, expect: EXPECT });
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
    ['error', config('observe', 'internal'), TOKEN, ['internal-error']],
    ['off', config('off'), TOKEN, []]
  ];
  for (const [result, c, token, codes] of cases) {
    const verdict = await checkTurnstile({ token, viewer: '192.0.2.1', config: c, expect: EXPECT });
    assert.equal(verdict.result, result, `${result} ${codes}`);
    assert.deepEqual(verdict.codes, codes, result);
    assert.equal(verdict.allowed, true, `${result} goes ahead in ${c.mode}`);
  }
});

test('a timeout ends the wait at the timeout, and a secret that cannot be read is an error', async () => {
  const started = Date.now();
  const verdict = await checkTurnstile({ token: TOKEN, viewer: '', config: config('enforce', 'hang'), expect: EXPECT });
  assert.equal(verdict.result, 'error');
  assert.equal(verdict.allowed, true, 'enforce fails open when Cloudflare can’t answer');
  assert.ok(Date.now() - started < 2000, 'it gave up at its own timeout');
  const outage = await checkTurnstile({
    token: TOKEN,
    viewer: '',
    config: config('enforce', 'internal'),
    expect: EXPECT
  });
  assert.equal(outage.result, 'error', 'Cloudflare’s internal-error is its fault, not a rejected token');
  assert.equal(outage.allowed, true, 'so enforce lets it through');
  const broken: TurnstileConfig = {
    ...config('enforce'),
    secret: async () => {
      throw Object.assign(new Error('the secret, quoted'), { name: 'AccessDeniedException' });
    }
  };
  const lookup = await checkTurnstile({ token: TOKEN, viewer: '', config: broken, expect: EXPECT });
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
  const missing = await checkTurnstile({ token: '', viewer: '', config: config('enforce'), expect: EXPECT });
  assert.deepEqual([missing.result, missing.allowed], ['missing', false]);
  const noSecret = await checkTurnstile({
    token: '',
    viewer: '',
    config: config('enforce', 'pass', null),
    expect: EXPECT
  });
  assert.deepEqual([noSecret.result, noSecret.allowed], ['unconfigured', true], 'no secret yet: nobody is refused');
});

test('the widget’s hostnames come from the configured origins: the site, its www and Quiz', () => {
  assert.deepEqual(widgetHostnames('https://roadsignmath.xyz', 'https://quiz.roadsignmath.xyz'), [
    'roadsignmath.xyz',
    'www.roadsignmath.xyz',
    'quiz.roadsignmath.xyz'
  ]);
  assert.deepEqual(widgetHostnames(SITE, QUIZ), ['example.test', 'www.example.test', 'quiz.example.test']);
  assert.equal(turnstileAction('site'), 'signin-site');
  assert.equal(turnstileAction('quiz'), 'signin-quiz');
});

test('a pass made on another hostname, or for another action, is a fail that says which', async () => {
  const quizForm: TurnstileExpect = { ...EXPECT, action: 'signin-quiz' };
  const cases: [string, Made, TurnstileExpect, string, string[]][] = [
    ['the site', { hostname: 'example.test', action: 'signin-site' }, EXPECT, 'pass', []],
    ['www', { hostname: 'www.example.test', action: 'signin-site' }, EXPECT, 'pass', []],
    ['Quiz', { hostname: 'quiz.example.test', action: 'signin-quiz' }, quizForm, 'pass', []],
    ['any case', { hostname: 'Example.TEST', action: 'signin-site' }, EXPECT, 'pass', []],
    ['elsewhere', { hostname: 'elsewhere.test', action: 'signin-site' }, EXPECT, 'fail', ['hostname-mismatch']],
    [
      'a lookalike',
      { hostname: 'example.test.elsewhere.test', action: 'signin-site' },
      EXPECT,
      'fail',
      ['hostname-mismatch']
    ],
    ['no hostname', { action: 'signin-site' }, EXPECT, 'fail', ['hostname-mismatch']],
    ['the other front', { hostname: 'example.test', action: 'signin-quiz' }, EXPECT, 'fail', ['action-mismatch']],
    ['no action', { hostname: 'example.test' }, EXPECT, 'fail', ['action-mismatch']],
    ['both', { hostname: 'elsewhere.test', action: 'login' }, EXPECT, 'fail', ['hostname-mismatch', 'action-mismatch']]
  ];
  for (const [name, made, expect, result, codes] of cases) {
    for (const mode of ['observe', 'enforce'] as const) {
      const verdict = await checkTurnstile({
        token: TOKEN,
        viewer: '',
        config: config(mode, 'pass', SECRET, made),
        expect
      });
      assert.equal(verdict.result, result, `${name} in ${mode}`);
      assert.deepEqual(verdict.codes, codes, name);
      assert.equal(verdict.allowed, mode === 'observe' || result === 'pass', `${name} in ${mode}`);
      assert.equal(verdict.hostname, made.hostname, 'what Cloudflare said is still logged');
      assert.equal(verdict.action, made.action);
    }
  }
  // A rejected token stays Cloudflare's fail, with its own codes only.
  const rejected = await checkTurnstile({
    token: TOKEN,
    viewer: '',
    config: config('enforce', 'fail'),
    expect: EXPECT
  });
  assert.deepEqual([rejected.result, rejected.codes], ['fail', ['invalid-input-response']]);
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
  /** A pass made where this front's widget is drawn, for its form. */
  const made: Made = {
    hostname: front === 'quiz' ? 'quiz.example.test' : 'example.test',
    action: turnstileAction(front)
  };
  const cfg = (mode: TurnstileMode, answer: Answer = 'pass', secret: string | null = SECRET) =>
    config(mode, answer, secret, made);

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
    const t = setup(cfg('observe'));
    const page = await t.request(front, '/signin');
    assert.match(page.html, /<form[^>]* data-turnstile=""/);
    assert.match(page.html, /class="ts-slot" data-sitekey="1x00000000000000000000AA"/);
    assert.match(page.html, new RegExp(`data-action="signin-${front}"`));
    assert.match(page.html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
    assert.deepEqual(
      { ...hiddenFields(page.html), at: undefined },
      { at: undefined, turnstile_token: '', turnstile_reason: 'no-script', turnstile_wait_ms: '' }
    );
    const off = setup(cfg('off'));
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
      const t = setup(cfg('observe', answer));
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
    const c = cfg('enforce', 'pass', null);
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
      const t = setup(cfg('enforce', answer));
      const { lines } = await logged(async () => {
        const res = await t.request(front, '/signin', { email: EMAIL, turnstile_token: token });
        assert.equal(res.res.status, status, `${answer} ${token ? 'token' : 'none'}`);
        if (status === 403) {
          assert.equal(NOT_CHECKED, 'We couldn’t confirm you’re not a bot. Reload the page and try again.');
          assert.ok(plain(res.html).includes(NOT_CHECKED), 'it says why');
          assert.match(res.html, new RegExp(`name="email"[^>]* value="${EMAIL}"`), 'what was typed is kept');
          assert.match(res.html, /class="ts-slot"/, 'with a new widget');
          assert.ok(res.html.includes('rsmTurnstileLoaded'), 'and the script that draws it');
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

  test(`${front}: a token made for the other front’s form is refused in enforce and logged in observe`, async () => {
    const other = front === 'site' ? 'quiz' : 'site';
    for (const mode of ['observe', 'enforce'] as const) {
      const t = setup(config(mode, 'pass', SECRET, { ...made, action: turnstileAction(other) }));
      const { lines } = await logged(async () => {
        const res = await t.request(front, '/signin', { email: EMAIL, turnstile_token: TOKEN });
        assert.equal(res.res.status, mode === 'enforce' ? 403 : 303, mode);
      });
      assert.equal(t.mailer.sent.length, mode === 'enforce' ? 0 : 1, mode);
      assert.deepEqual(
        [lines[0]!.result, lines[0]!.codes, lines[0]!.action],
        ['fail', 'action-mismatch', turnstileAction(other)],
        mode
      );
    }
  });

  test(`${front}: Turnstile runs before the pause, so a quick post is logged too; a resend is not checked`, async () => {
    const c = cfg('observe');
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

// ---- The page's script, run here as a browser would, with a made-up page, clock and widget

/** The sign-in form's script on a made-up page: the clock, Cloudflare's script and widget are the test's to move. */
function pageScript() {
  let now = 0;
  let nextId = 1;
  let timers: { id: number; at: number; run: () => void }[] = [];
  const fields: Record<string, { value: string }> = {
    turnstile_token: { value: '' },
    turnstile_reason: { value: 'no-script' },
    turnstile_wait_ms: { value: '' }
  };
  const posts: Record<string, string>[] = [];
  let onSubmit: ((event: { preventDefault: () => void }) => void) | undefined;
  const slot = { dataset: { sitekey: '1x00000000000000000000AA', action: 'signin-site' } as Record<string, string> };
  const form = {
    querySelector: (selector: string) => {
      if (selector === '.ts-slot') return slot;
      const name = /name="([^"]+)"/.exec(selector)?.[1];
      return name ? fields[name] : null;
    },
    addEventListener: (_type: string, listener: typeof onSubmit) => void (onSubmit = listener),
    submit: () =>
      void posts.push(
        Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])) as Record<string, string>
      )
  };
  const script: { src?: string; onerror?: () => void } = {};
  type Options = Record<string, unknown> & {
    callback: (token: string) => void;
    'error-callback': (code: string) => unknown;
    'before-interactive-callback': () => void;
  };
  let options: Options | undefined;
  const window: Record<string, unknown> = {};
  runInNewContext(TURNSTILE_JS, {
    window,
    document: {
      querySelector: (selector: string) => (selector === 'form[data-turnstile]' ? form : null),
      createElement: () => script,
      head: { appendChild: () => {} }
    },
    setTimeout: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, run });
      return id;
    },
    clearTimeout: (id: number) => void (timers = timers.filter((t) => t.id !== id)),
    Date: { now: () => now }
  });
  return {
    posts,
    slot,
    options: () => options!,
    /** Cloudflare's script arrives, with the widget, or without its API. */
    load(api = true) {
      if (api) window.turnstile = { render: (_slot: unknown, given: Options) => void (options = given) };
      (window.rsmTurnstileLoaded as () => void)();
    },
    blocked: () => script.onerror!(),
    press: () => onSubmit!({ preventDefault: () => {} }),
    /** Moves the clock on, running each timer as it comes due. */
    wait(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.run();
      }
      now = until;
    }
  };
}

test('the widget retries on its own, under the wait, and the error callback leaves it to', () => {
  const page = pageScript();
  page.load();
  const options = page.options();
  assert.equal(options.retry, 'auto');
  assert.equal(options['retry-interval'], RETRY_INTERVAL_MS);
  assert.ok(RETRY_INTERVAL_MS < 5000, 'a retry fits inside the five seconds');
  assert.ok(!options['error-callback']('600010'), 'falsy: Cloudflare goes on retrying');
});

test('a retryable error waits for the retry: a token that comes in time is posted', () => {
  const page = pageScript();
  page.load();
  page.options()['error-callback']('600010');
  page.press();
  page.wait(1000);
  assert.equal(page.posts.length, 0, 'the first error is not the end');
  page.options()['error-callback']('600010');
  page.wait(1000);
  page.options().callback('a-token');
  assert.equal(page.posts.length, 1);
  assert.deepEqual(page.posts[0], { turnstile_token: 'a-token', turnstile_reason: '', turnstile_wait_ms: '2000' });
});

test('an error before the press is forgotten once the retry brings a token', () => {
  const page = pageScript();
  page.load();
  page.options()['error-callback']('600010');
  page.wait(2500);
  page.options().callback('a-token');
  page.press();
  assert.deepEqual(page.posts, [{ turnstile_token: 'a-token', turnstile_reason: '', turnstile_wait_ms: '0' }]);
});

test('when the five seconds run out after an error, the form goes without a token and says the last error', () => {
  const page = pageScript();
  page.load();
  page.press();
  page.options()['error-callback']('600010');
  page.wait(3000);
  page.options()['error-callback']('300030');
  page.wait(1900);
  assert.equal(page.posts.length, 0, 'not before the five seconds');
  page.wait(200);
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0]!.turnstile_token, '');
  assert.equal(page.posts[0]!.turnstile_reason, 'error:300030');
  assert.ok(Number(page.posts[0]!.turnstile_wait_ms) >= 5000 && Number(page.posts[0]!.turnstile_wait_ms) < 5300);
  page.wait(10_000);
  page.press();
  assert.equal(page.posts.length, 1, 'one press, one post');
});

test('with no error and no token the reasons are the timeouts they were', () => {
  const quiet = pageScript();
  quiet.load();
  quiet.press();
  quiet.wait(5300);
  assert.equal(quiet.posts[0]!.turnstile_reason, 'solving-timeout');
  const asking = pageScript();
  asking.load();
  asking.options()['before-interactive-callback']();
  assert.equal(asking.slot.dataset.turnstile, 'asking');
  asking.press();
  asking.wait(60_000);
  assert.equal(asking.posts.length, 0, 'two minutes while a checkbox shows');
  asking.wait(60_300);
  assert.equal(asking.posts[0]!.turnstile_reason, 'interactive-timeout');
  const never = pageScript();
  never.press();
  never.wait(5300);
  assert.equal(never.posts[0]!.turnstile_reason, 'loading-timeout');
});

test('a script that did not load, or came empty, and the codes Cloudflare never retries, post at once', () => {
  const blocked = pageScript();
  blocked.press();
  blocked.blocked();
  assert.deepEqual(blocked.posts, [
    { turnstile_token: '', turnstile_reason: 'script-blocked', turnstile_wait_ms: '0' }
  ]);
  const empty = pageScript();
  empty.load(false);
  empty.press();
  assert.deepEqual(empty.posts, [{ turnstile_token: '', turnstile_reason: 'script-empty', turnstile_wait_ms: '0' }]);
  for (const code of FINAL_CODES) {
    const page = pageScript();
    page.load();
    page.press();
    page.wait(100);
    page.options()['error-callback'](code);
    assert.equal(page.posts.length, 1, code);
    assert.equal(page.posts[0]!.turnstile_reason, `error:${code}`);
  }
});
