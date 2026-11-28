// The pause a sign-in form asks for (src/quiz/pause.ts): a form posted sooner after it was drawn
// than anyone types an address sends no email, on the website and in Quiz, and the next press of a
// person who was that quick goes through. Fictional addresses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { TOO_QUICK } from '../src/quiz/account.tsx';
import { SIGN_IN_PAUSE, STAMP_KEPT, formStamp, tooQuick } from '../src/quiz/pause.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ScriptedModerator } from './support/moderator.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';

function setup(signInPause: number | 'unset' = SIGN_IN_PAUSE) {
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
    ...(signInPause !== 'unset' && { signInPause })
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

const stampIn = (html: string) => /<input type="hidden" name="at" value="([0-9a-z]+)"/.exec(html)?.[1];
const typed = (html: string) => /name="email"[^>]* value="([^"]*)"/.exec(html)?.[1];
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
/** What `console.info` was given while `run` ran. */
async function logged(run: () => Promise<void>): Promise<unknown[]> {
  const lines: unknown[] = [];
  const info = console.info;
  console.info = (line: unknown) => void lines.push(line);
  try {
    await run();
  } finally {
    console.info = info;
  }
  return lines;
}

test('a stamp is the time in base 36, and too quick is under the pause, no stamp, or one from later', () => {
  const now = 1_795_852_523_669;
  assert.equal(parseInt(formStamp(now), 36), now);
  assert.equal(tooQuick(formStamp(now - 700), 3000, now), true, 'the crawler’s 0.7 seconds');
  assert.equal(tooQuick(formStamp(now - 2999), 3000, now), true);
  assert.equal(tooQuick(formStamp(now - 3000), 3000, now), false);
  assert.equal(tooQuick(formStamp(now - STAMP_KEPT), 3000, now), false, 'a form left open a day');
  assert.equal(tooQuick(formStamp(now - STAMP_KEPT - 1), 3000, now), true, 'and one left open longer');
  assert.equal(tooQuick(formStamp(now + 60_000), 3000, now), true, 'from later than now');
  for (const bad of ['', '0', 'soon', '-1', 'ABC', '1.5', ' 1', 'zzzzzzzzzzzz', '<script>'])
    assert.equal(tooQuick(bad, 3000, now), true, bad);
  assert.equal(tooQuick('', 0, now), false, 'no pause asked for');
  assert.equal(SIGN_IN_PAUSE, 3000);
});

for (const front of ['site', 'quiz'] as const) {
  test(`${front}: a form posted at once sends no email, and the form drawn again goes through`, async () => {
    const t = setup();
    const page = await t.request(front, '/signin');
    const at = stampIn(page.html);
    assert.ok(at, 'the form says when it was drawn');
    assert.ok(Date.now() - parseInt(at, 36) < 5000);

    let refused!: Awaited<ReturnType<typeof t.request>>;
    const lines = await logged(async () => {
      refused = await t.request(front, '/signin', { email: 'pat@example.com', at });
    });
    assert.equal(refused.res.status, 429);
    assert.equal(t.mailer.sent.length, 0, 'no email');
    assert.equal(await t.store.bump('total', 3600, Math.floor(Date.now() / 1000)), 1, 'and no try counted before it');
    assert.ok(plain(refused.html).includes(TOO_QUICK), 'it says to press once more');
    assert.equal(typed(refused.html), 'pat@example.com', 'what they typed is kept');
    assert.deepEqual(lines, [{ event: 'limited', limit: 'quick' }], 'counted by kind, never by address');

    const again = await t.request(front, '/signin', { email: 'pat@example.com', at: stampIn(refused.html)! });
    assert.equal(again.res.status, 303, 'the next press goes through, however soon');
    assert.match(again.location!, /^\/signin\/code\?l=[0-9A-Z]{26}$/);
    assert.equal(t.mailer.sent.length, 1);
  });

  test(`${front}: a form with no stamp, or a made-up one, sends nothing; one a person read does`, async () => {
    const t = setup();
    await logged(async () => {
      for (const at of [
        undefined,
        '',
        'soon',
        formStamp(Date.now() + 3_600_000),
        formStamp(Date.now() - STAMP_KEPT - 1000)
      ]) {
        const refused = await t.request(front, '/signin', {
          email: 'pat@example.com',
          ...(at !== undefined && { at })
        });
        assert.equal(refused.res.status, 429, String(at));
      }
    });
    assert.equal(t.mailer.sent.length, 0);

    const read = await t.request(front, '/signin', { email: 'pat@example.com', at: formStamp(Date.now() - 3000) });
    assert.equal(read.res.status, 303);
    assert.equal(t.mailer.sent.length, 1);
  });

  test(`${front}: “Send the email again” on the code page needs no pause`, async () => {
    const t = setup();
    const sent = await t.request(front, '/signin', { email: 'pat@example.com', at: formStamp(Date.now() - 5000) });
    const login = /l=([0-9A-Z]{26})/.exec(sent.location!)![1]!;
    const again = await t.request(front, '/signin', { again: '1', login });
    assert.equal(again.res.status, 303);
    assert.match(again.location!, /said=sent$/);
    assert.equal(t.mailer.sent.length, 2);
  });

  test(`${front}: a bad address drawn again keeps a stamp, and no pause is asked where none is set`, async () => {
    const t = setup();
    const at = formStamp(Date.now() - 5000);
    const bad = await t.request(front, '/signin', { email: 'not an address', at });
    assert.equal(bad.res.status, 400);
    assert.equal(stampIn(bad.html), at, 'mending a typo is never too quick: the stamp it came with stays');

    const open = setup('unset');
    const sent = await open.request(front, '/signin', { email: 'pat@example.com' });
    assert.equal(sent.res.status, 303, 'as tests post it');
    assert.equal(open.mailer.sent.length, 1);
  });
}
