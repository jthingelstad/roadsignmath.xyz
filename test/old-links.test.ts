import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { createApp } from '../src/api/app.ts';
import { photoUrl, signUrl } from '../src/api/views.ts';
import { ulidFrom } from '../src/domain/ids.ts';
import type { Sign } from '../src/domain/types.ts';
import { PAGE_CACHE } from '../src/edge-cache.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { buildPlan, seedKeys, type FeedItem, type SeedFile } from '../src/seed/microblog.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { createOldLinks, MICROBLOG_POSTS, type OldPost } from '../src/web/old-links.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign } from './support/fixtures.ts';

const urls = { site: 'https://example.test' };

/** Fictional old posts: two share a name, one is named by its time. */
const posts: OldPost[] = [
  { post: '2026/01/10/testville.html', uploads: ['uploads/2026/aaaa.jpg', 'uploads/2026/bbbb.jpg'] },
  { post: '2026/01/11/sqrt.html', uploads: ['uploads/2026/cccc.jpg'] },
  { post: '2026/01/12/sqrt.html', uploads: [] },
  { post: '2026/01/13/120000.html', uploads: [] },
  { post: '2026/01/14/hidden-hill.html', uploads: ['uploads/2026/dddd.jpg'] }
];

/** A sign made from an old post as the seed makes it: its ids come from the post. */
function seeded(post: string, overrides: Partial<Sign> & { title: string }, photos = 1): Sign {
  const time = Date.parse(`${post.slice(0, 10).replaceAll('/', '-')}T18:00:00Z`);
  return sign({
    id: ulidFrom(time, seedKeys.sign(post)),
    photos: Array.from({ length: photos }, (_, i) => ({
      id: ulidFrom(time, seedKeys.photo(post, i)).toLowerCase(),
      width: 1600,
      height: 1200,
      alt: `Photo of the ${overrides.title} sign`
    })),
    ...overrides
  });
}

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  const signs = {
    testville: seeded(posts[0].post, { title: 'Testville' }, 2),
    first: seeded(posts[1].post, {
      title: 'Root One',
      place: { label: 'Faketown, New York', state: 'NY', approximate: true }
    }),
    second: seeded(posts[2].post, { title: 'Root Two' }),
    time: seeded(posts[3].post, { title: 'Noon' }),
    hidden: seeded(posts[4].post, { title: 'Hidden Hill', visibility: 'hidden' })
  };
  for (const s of Object.values(signs)) await store.putSign(s);
  const app = new Hono();
  app.route('/', createOldLinks({ store, urls, posts }));
  app.notFound((c) => c.text('not found', 404));
  return { app, store, signs };
}

async function goes(app: Hono, path: string): Promise<string | null> {
  const res = await app.request(path);
  if (res.status === 404) return null;
  assert.equal(res.status, 301, path);
  assert.equal(res.headers.get('cache-control'), PAGE_CACHE, path);
  return res.headers.get('location');
}

test('an old post goes to its sign’s page, and so does its name alone', async () => {
  const { app, signs } = await setup();
  assert.equal(await goes(app, '/2026/01/10/testville.html'), signUrl(urls, signs.testville));
  assert.equal(await goes(app, '/testville'), signUrl(urls, signs.testville));
  assert.equal(await goes(app, '/2026/01/11/sqrt.html'), signUrl(urls, signs.first));
  assert.equal(await goes(app, '/2026/01/12/sqrt.html'), signUrl(urls, signs.second));
  assert.equal(await goes(app, '/2026/01/13/120000.html'), signUrl(urls, signs.time));
});

test('a renamed sign is still found, at its new address', async () => {
  const { app, store, signs } = await setup();
  await store.putSign({ ...signs.testville, slug: 'testville-junction' });
  assert.equal(await goes(app, '/2026/01/10/testville.html'), 'https://example.test/signs/testville-junction');
});

test('a name two posts shared, or a time, is not a short address', async () => {
  const { app } = await setup();
  assert.equal(await goes(app, '/sqrt'), null);
  assert.equal(await goes(app, '/120000'), null);
});

test('an unknown old post, and a hidden or held sign’s, is a 404', async () => {
  const { app, store, signs } = await setup();
  assert.equal(await goes(app, '/2026/01/15/nowhere.html'), null);
  assert.equal(await goes(app, '/2026/01/10/testville'), null);
  assert.equal(await goes(app, '/2026/01/14/hidden-hill.html'), null);
  assert.equal(await goes(app, '/hidden-hill'), null);
  await store.putSign({ ...signs.testville, visibility: 'held' });
  assert.equal(await goes(app, '/2026/01/10/testville.html'), null);
  await store.deleteSign(signs.first.id);
  assert.equal(await goes(app, '/2026/01/11/sqrt.html'), null);
});

test('an old post’s photo goes to that photo, while its sign is shown and still has it', async () => {
  const { app, store, signs } = await setup();
  const [one, two] = signs.testville.photos;
  assert.equal(await goes(app, '/uploads/2026/aaaa.jpg'), photoUrl(urls, one.id, 'large'));
  assert.equal(await goes(app, '/uploads/2026/bbbb.jpg'), photoUrl(urls, two.id, 'large'));
  assert.equal(await goes(app, '/uploads/2026/cccc.jpg'), photoUrl(urls, signs.first.photos[0].id, 'large'));
  assert.equal(await goes(app, '/uploads/2026/dddd.jpg'), null);
  assert.equal(await goes(app, '/uploads/2026/eeee.jpg'), null);
  await store.putSign({ ...signs.testville, photos: [one] });
  assert.equal(await goes(app, '/uploads/2026/bbbb.jpg'), null);
});

test('a state’s category goes to the signs from that state, when it has one', async () => {
  const { app } = await setup();
  assert.equal(await goes(app, '/categories/minnesota'), '/signs?state=MN');
  assert.equal(await goes(app, '/categories/new-york'), '/signs?state=NY');
  assert.equal(await goes(app, '/categories/Minnesota'), '/signs?state=MN');
  assert.equal(await goes(app, '/categories/texas'), null);
  assert.equal(await goes(app, '/categories/atlantis'), null);
});

test('the archive and photos pages go to every sign, and /feed to the feed', async () => {
  const { app } = await setup();
  assert.equal(await goes(app, '/archive'), '/signs');
  assert.equal(await goes(app, '/photos'), '/signs');
  assert.equal(await goes(app, '/feed'), '/feed.xml');
});

test('every post in seed/microblog.json goes to the sign the seed made from it', async () => {
  // Checks the committed launch set as data; it names no one here.
  const launch = JSON.parse(await readFile('seed/microblog.json', 'utf8')) as SeedFile;
  assert.deepEqual(
    MICROBLOG_POSTS,
    launch.signs.map((s) => ({ post: s.post, uploads: s.uploads }))
  );
  const feed: FeedItem[] = launch.signs.map((s, i) => ({
    url: `https://blog.example/${s.post}`,
    content_text: s.uploads.map((u) => `<img src="${u}" alt="">`).join('\n\n'),
    date_published: `${s.post.slice(0, 10).replaceAll('/', '-')}T12:00:${String(i).padStart(2, '0')}-05:00`
  }));
  const plan = buildPlan(feed, launch);
  const store = new MemoryStore();
  for (const p of plan.players) await addPlayer(store, p);
  for (const s of plan.signs) await addSign(store, s);
  const app = createApp({
    store,
    urls,
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  for (const [i, s] of launch.signs.entries()) {
    const res = await app.request(`/${s.post}`);
    assert.equal(res.status, 301, s.post);
    assert.equal(res.headers.get('location'), signUrl(urls, plan.signs[i]));
    assert.equal(res.headers.get('cache-control'), PAGE_CACHE);
    for (const [j, upload] of s.uploads.entries()) {
      const photo = await app.request(`/${upload}`);
      assert.equal(photo.headers.get('location'), photoUrl(urls, plan.signs[i].photos[j].id, 'large'), upload);
    }
  }
  // The site's own pages come first, and a trailing slash still finds its way.
  assert.equal((await app.request('/about')).status, 200);
  assert.equal((await app.request('/archive/')).headers.get('location'), '/archive');
  // A hidden sign's post is the site's 404 page, kept at the edge like any.
  await store.updateSign(plan.signs[0].id, { visibility: 'hidden' });
  const gone = await app.request(`/${launch.signs[0].post}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.headers.get('cache-control'), PAGE_CACHE);
  assert.match(await gone.text(), /This road doesn’t go anywhere/);
});

test('a post whose sign was merged into another goes there, and so do the photos the merge kept', async () => {
  const { app, store, signs } = await setup();
  const [kept, dropped] = signs.testville.photos;
  // Testville merged into Root Two, keeping its first photo only.
  await store.updateSign(signs.second.id, {
    photos: [kept, ...signs.second.photos],
    merged: [
      { signId: signs.testville.id, slug: 'testville', at: '2026-11-12T00:00:00.000Z', photosRemoved: [dropped.id] }
    ]
  });
  await store.deleteSign(signs.testville.id);
  assert.equal(await goes(app, '/2026/01/10/testville.html'), signUrl(urls, signs.second));
  assert.equal(await goes(app, '/testville'), signUrl(urls, signs.second));
  assert.equal(await goes(app, '/uploads/2026/aaaa.jpg'), photoUrl(urls, kept.id, 'large'));
  assert.equal(await goes(app, '/uploads/2026/bbbb.jpg'), null);
});
