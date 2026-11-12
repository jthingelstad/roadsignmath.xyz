import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { QUIZ_OPEN } from '../src/quiz/quiz.tsx';
import { MemoryStore } from '../src/store/memory.ts';
import { ScriptedModerator } from './support/moderator.ts';

const app = createApp({
  store: new MemoryStore(),
  urls: { site: 'https://example.test' },
  mailer: new MemoryMailer(),
  photos: new MemoryPhotoStore(),
  moderator: new ScriptedModerator()
});
const quiz = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-RSM-Front': 'quiz' } });

test('Quiz is closed until Jamie opens it', () => {
  assert.equal(QUIZ_OPEN, false);
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
