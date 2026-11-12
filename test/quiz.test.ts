import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { QUIZ_OPEN } from '../src/quiz/quiz.tsx';
import { QUIZ_TINYLYTICS_SITE, TINYLYTICS_SCRIPT, TINYLYTICS_SITE } from '../src/web/tinylytics.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ScriptedModerator } from './support/moderator.ts';

const options = {
  store: new MemoryStore(),
  urls: { site: 'https://example.test' },
  mailer: new MemoryMailer(),
  photos: new MemoryPhotoStore(),
  moderator: new ScriptedModerator()
};
// Switched off, as it was until Jamie opened it, and as `QUIZ_OPEN = false` would make it again.
const app = createApp({ ...options, quizOpen: false });
const open = createApp(options);
const quiz = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-RSM-Front': 'quiz' } });

test('Quiz is open (Jamie, 2026-11-12), and by default its front serves Quiz, with its own counter', async () => {
  assert.equal(QUIZ_OPEN, true);
  const home = await open.request('/', { headers: { 'X-RSM-Front': 'quiz' } });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-robots-tag'), null, 'search engines may find its home');
  const html = await home.text();
  assert.ok(!html.includes('Coming soon'));
  assert.ok(html.includes('Find the math in a road sign.'));
  assert.ok(html.includes(`<script defer="" src="${TINYLYTICS_SCRIPT}" data-site="${QUIZ_TINYLYTICS_SITE}">`));
  assert.ok(!html.includes(TINYLYTICS_SITE), 'never the website’s site id');
  const robots = await open.request('/robots.txt', { headers: { 'X-RSM-Front': 'quiz' } });
  assert.equal(await robots.text(), 'User-agent: *\nAllow: /$\nDisallow: /\n');
  const link = await open.request('/signin?l=L1&t=secret-token', { headers: { 'X-RSM-Front': 'quiz' } });
  assert.ok(
    !(await link.text()).includes(TINYLYTICS_SCRIPT),
    'the sign-in link’s page, whose URL carries the token, isn’t counted'
  );
});

test('through Quiz’s front, every address is the coming-soon page, never the site or the API', async () => {
  for (const path of ['/', '/signs', '/api/v1', '/api/v1/signs', '/players/ada', '/nowhere']) {
    const res = await quiz(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path);
    const html = await res.text();
    assert.ok(html.includes('<h1>Road Sign Math Quiz</h1>'), path);
    assert.ok(html.includes('<a href="https://example.test">'), path);
    assert.ok(!html.includes('API-Version'), path);
  }
  assert.equal((await quiz('/api/v1/signs', { method: 'POST', body: '{}' })).status, 200, 'not the API');
  const robots = await quiz('/robots.txt');
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
});

test('without Quiz’s header, or with any other value, it is the site', async () => {
  for (const headers of [{}, { 'X-RSM-Front': 'site' }, { 'X-RSM-Front': 'QUIZ' }] as Record<string, string>[]) {
    const res = await app.request('/api/v1', { headers });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('api-version'));
    assert.ok(!(await (await app.request('/', { headers })).text()).includes('Coming soon'));
  }
});
