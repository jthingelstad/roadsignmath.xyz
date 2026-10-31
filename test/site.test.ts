import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign, way } from './support/fixtures.ts';

async function setup(appleTeamId?: string) {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await store.putSign(
    sign({ id: '01JS0000000000000000000001', title: 'Older Sign', postedAt: '2026-01-01T00:00:00.000Z' })
  );
  await store.putSign(
    sign({ id: '01JS0000000000000000000002', title: 'Newer Sign', postedAt: '2026-02-01T00:00:00.000Z' })
  );
  await store.putSign(sign({ id: '01JS0000000000000000000003', title: 'Held Sign', visibility: 'held' }));
  await store.addWay(way('01JS0000000000000000000002', { text: '18 ÷ 6 = 3', value: '3', numbers: ['18', '6', '3'] }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    appleTeamId
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
  // Tinylytics counts the visit.
  assert.match(
    html,
    /<script defer="" src="https:\/\/tinylytics\.app\/js\/script\.js" data-site="ryhTaXDDgZtyCktoVzzj"><\/script>/
  );
});

test('every sign has a heart: Tinylytics’ kudos button at the sign’s path', async () => {
  const { app, slug } = await setup();
  const home = await (await app.request('/')).text();
  const button = (s: string) =>
    `<button type="button" class="tinylytics_kudos" data-path="/signs/${s}" aria-label="Heart the`;
  assert.ok(home.includes(button(slug('Newer Sign'))));
  assert.ok(home.includes(button(slug('Older Sign'))));
  // Outside the card's link, so a tap hearts the sign instead of opening it.
  assert.match(home, /<\/a><div class="foot"><button type="button" class="tinylytics_kudos"/);
  const page = await (await app.request(`/signs/${slug('Newer Sign')}`)).text();
  assert.equal(page.split('class="tinylytics_kudos"').length, 2);
  assert.ok(page.includes(button(slug('Newer Sign'))));
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

test('the math is drawn as SVG, with the text for screen readers', async () => {
  const { app, slug } = await setup();
  const drawn = (label: string) =>
    new RegExp(`<span class="math" role="img" aria-label="${label}"><svg aria-hidden="true" `);
  assert.match(await (await app.request('/')).text(), drawn('7 \\+ 12 = 19'));
  assert.match(await (await app.request(`/signs/${slug('Newer Sign')}`)).text(), drawn('18 ÷ 6 = 3'));
});

test('apple-app-site-association opens the sign-in link and sign pages in the app', async () => {
  const { app } = await setup('ABCDE12345');
  for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    const body = (await res.json()) as { applinks: { details: unknown[] } };
    assert.deepEqual(body.applinks.details, [
      {
        appIDs: ['ABCDE12345.xyz.roadsignmath.app'],
        components: [
          { '/': '/signin', comment: 'The sign-in link in the email' },
          { '/': '/signs/?*', comment: 'A sign’s page' }
        ]
      }
    ]);
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path}`);
  }
});

test('without a team id there is no apple-app-site-association', async () => {
  const { app } = await setup();
  assert.equal((await app.request('/.well-known/apple-app-site-association')).status, 404);
  assert.equal((await app.request('/apple-app-site-association')).status, 404);
});

test('the sign-in link in a browser says where to use it, and is never cached', async () => {
  const { app } = await setup('ABCDE12345');
  const res = await app.request('/signin?l=01JLOGIN&t=secret-token-value');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.match(html, /Sign in on your iPhone/);
  assert.ok(!html.includes('secret-token-value'));
  assert.ok(!html.includes('01JLOGIN'));
  // No analytics here: the URL holds the link's token.
  assert.ok(!html.includes('tinylytics'));
});
