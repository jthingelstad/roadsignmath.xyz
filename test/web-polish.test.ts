import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { photoCap, photoSrcset } from '../src/web/cards.tsx';
import { jsonLdText } from '../src/web/layout.tsx';
import { signDescription } from '../src/web/site.tsx';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign, way } from './support/fixtures.ts';

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await store.putSign(
    sign({
      id: '01JS0000000000000000000001',
      title: 'Genesis',
      postedAt: '2026-01-01T00:00:00.000Z',
      finders: [{ name: 'Ada', playerId: ada.id, role: 'found' }]
    })
  );
  await store.putSign(
    sign({
      id: '01JS0000000000000000000002',
      title: 'Small Sign',
      postedAt: '2026-02-01T00:00:00.000Z',
      photos: [
        { id: 'ph-big', width: 1600, height: 1200, alt: 'Photo of the Small Sign sign' },
        { id: 'ph-small', width: 300, height: 200, alt: 'A close look' }
      ],
      finders: [{ name: 'Ada', playerId: ada.id, role: 'found' }]
    })
  );
  await store.addWay(way('01JS0000000000000000000002', { text: '18 ÷ 6 = 3', value: '3', numbers: ['18', '6', '3'] }));
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const html = async (path: string) => {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    return res.text();
  };
  return { app, html };
}

const ogImage = (page: string) => /<meta property="og:image" content="([^"]+)"/.exec(page)?.[1];
const ogType = (page: string) => /<meta property="og:type" content="([^"]+)"/.exec(page)?.[1];
const ld = (page: string) =>
  [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('every page without a card of its own shares Home’s, and says what it is for Open Graph', async () => {
  const { html } = await setup();
  const home = await html('/');
  const card = ogImage(home);
  assert.match(card ?? '', /^https:\/\/cards\.thingelstad\.com\/rsm\/index\.png\?v=[0-9a-f]{10}$/);
  for (const path of [
    '/signs',
    '/signs?sort=popular',
    '/players',
    '/app',
    '/about',
    '/privacy',
    '/rules',
    '/support',
    '/data'
  ]) {
    const page = await html(path);
    assert.equal(ogImage(page), card, path);
    assert.equal(ogType(page), 'website', path);
    assert.match(page, /<meta name="twitter:card" content="summary_large_image"\/>/, path);
  }
  assert.equal(ogType(home), 'website');
  assert.equal(ogType(await html('/signs/small-sign')), 'article');
  assert.equal(ogType(await html('/players/ada')), 'profile');
  // A sign and a player keep their own cards.
  assert.match(ogImage(await html('/signs/small-sign')) ?? '', /\/rsm\/signs\/small-sign\.png/);
});

test('Home says it is a WebSite and /app a free iPhone app, as JSON-LD', async () => {
  const { html } = await setup();
  const [site] = ld(await html('/'));
  assert.equal(site['@type'], 'WebSite');
  assert.equal(site.url, 'https://example.test/');
  const [app] = ld(await html('/app'));
  assert.equal(app['@type'], 'MobileApplication');
  assert.equal(app.operatingSystem, 'iOS');
  assert.equal(app.applicationCategory, 'GameApplication');
  assert.deepEqual(app.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD' });
  assert.match(app.url, /^https:\/\/apps\.apple\.com\//);
  // Nothing in the data can close its script.
  assert.equal(jsonLdText({ name: '</script><b>' }), '{"name":"\\u003c/script>\\u003cb>"}');
});

test('a sign’s photos offer both sizes, and a small one is never drawn past twice its width', async () => {
  const { html } = await setup();
  const page = await html('/signs/small-sign');
  assert.match(
    page,
    /<img src="https:\/\/example\.test\/p\/ph-big\/large\.jpg" srcset="https:\/\/example\.test\/p\/ph-big\/thumb\.jpg 480w, https:\/\/example\.test\/p\/ph-big\/large\.jpg 1600w" sizes="[^"]+"/
  );
  // The small photo is its own thumb: one size, capped at 600 px.
  assert.match(
    page,
    /<img src="https:\/\/example\.test\/p\/ph-small\/large\.jpg"(?![^>]*srcset)[^>]*style="max-width: min\(100%, 600px\)"/
  );
  assert.equal(photoSrcset({ id: 'x', width: 480, height: 360, alt: '', url: 'L', thumb_url: 'T' }), undefined);
  assert.equal(photoSrcset({ id: 'x', width: 800, height: 600, alt: '', url: 'L', thumb_url: 'T' }), 'T 480w, L 800w');
  assert.equal(photoCap({ width: 160 }), 'max-width: min(100%, 320px)');
});

test('/about draws its first sign from the thumb', async () => {
  const { html } = await setup();
  const page = await html('/about');
  assert.ok(page.includes('https://example.test/p/ph-01JS0000000000000000000001/thumb.jpg'));
  assert.ok(!page.includes('https://example.test/p/ph-01JS0000000000000000000001/large.jpg'));
});

test('a sign’s description says something its title doesn’t', async () => {
  const { html } = await setup();
  const page = await html('/signs/small-sign');
  const description = /<meta name="description" content="([^"]+)"/.exec(page)?.[1] ?? '';
  assert.ok(!description.startsWith('Small Sign'), description);
  assert.equal(description, '18 ÷ 6 = 3. A road sign found by Ada on Jan 10, 2026. Testville, Minnesota.');
  assert.equal(
    signDescription({
      first_way: null,
      finders: [
        { name: 'Ada', handle: 'ada', url: null },
        { name: 'Ben', handle: null, url: null },
        { name: 'Cy', handle: null, url: null }
      ],
      place: { label: 'Somewhere', state: null, lat: null, lng: null, approximate: true },
      found_on: '2025-09-01',
      numbers: [{ value: '4' }, { value: '2' }]
    } as unknown as Parameters<typeof signDescription>[0]),
    'A road sign found by Ada, Ben and Cy on Sep 1, 2025. Somewhere. Nobody has solved it yet. The numbers are 4 and 2.'
  );
});

test('a slug or handle in capitals goes to its page in lower case, keeping the query', async () => {
  const { app } = await setup();
  const sign = await app.request('/signs/Small-Sign?utm=x');
  assert.equal(sign.status, 301);
  assert.equal(sign.headers.get('location'), '/signs/small-sign?utm=x');
  const player = await app.request('/players/ADA');
  assert.equal(player.status, 301);
  assert.equal(player.headers.get('location'), '/players/ada');
  assert.equal((await app.request('/signs/nothing-Here')).status, 404);
});

test('motion is only for readers who haven’t asked for less', async () => {
  const { html } = await setup();
  const home = await html('/');
  assert.match(home, /@media \(prefers-reduced-motion: no-preference\) \{ html \{ scroll-behavior: smooth; \} \}/);
  assert.match(home, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok(home.includes("matchMedia?.('(prefers-reduced-motion: reduce)')"));
  assert.ok(home.includes('zoomAnimation: !still'));
});

test('Home says every sign posted from the app shows up there; with no address for Quiz, the header leaves it out', async () => {
  // While Quiz is open and has an address, the header links it (test/quiz-links.test.ts).
  const { html } = await setup();
  const home = await html('/');
  assert.ok(home.includes('Every sign posted from the app shows up here.'));
  const header = /<header[\s\S]*?<\/header>/.exec(home)?.[0] ?? '';
  assert.ok(!/quiz/i.test(header));
});
