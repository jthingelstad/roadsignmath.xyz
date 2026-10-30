import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign } from './support/fixtures.ts';

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await store.putSign(
    sign({ id: '01JS0000000000000000000001', title: 'Older Sign', postedAt: '2026-01-01T00:00:00.000Z' })
  );
  await store.putSign(
    sign({ id: '01JS0000000000000000000002', title: 'Newer Sign', postedAt: '2026-02-01T00:00:00.000Z' })
  );
  await store.putSign(sign({ id: '01JS0000000000000000000003', title: 'Held Sign', visibility: 'held' }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const signs = await store.allSigns();
  return { app, slug: (title: string) => signs.find((s) => s.title === title)!.slug };
}

test('the home page lists shown signs, newest first, and is cached', async () => {
  const { app } = await setup();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const html = await res.text();
  assert.ok(html.indexOf('Newer Sign') < html.indexOf('Older Sign'));
  assert.ok(!html.includes('Held Sign'));
});

test('a sign has its own page; a held or unknown one is not found', async () => {
  const { app, slug } = await setup();
  const res = await app.request(`/signs/${slug('Newer Sign')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>Newer Sign<\/h1>/);
  assert.equal((await app.request(`/signs/${slug('Held Sign')}`)).status, 404);
  const missing = await app.request('/signs/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});
