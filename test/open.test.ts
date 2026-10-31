import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { GEO_FIELDS, HEADER_FIELDS, PLAYER_FIELDS, SIGN_FIELDS, type Field } from '../src/web/docs.tsx';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

const SITE = 'https://example.test';

async function setup() {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  await addPlayer(store, ben);
  await store.putSign(
    sign({ id: '01JS0000000000000000000001', title: 'Older Sign', postedAt: '2026-01-01T00:00:00.000Z' })
  );
  await store.putSign(
    sign({
      id: '01JS0000000000000000000002',
      title: 'Newer Sign',
      caption: 'Seen on the way <home> & back',
      postedAt: '2026-02-01T00:00:00.000Z'
    })
  );
  await store.putSign(
    sign({
      id: '01JS0000000000000000000004',
      title: 'Nowhere Sign',
      postedAt: '2025-12-01T00:00:00.000Z',
      place: { label: 'Along the interstate', approximate: true }
    })
  );
  await store.putSign(sign({ id: '01JS0000000000000000000003', title: 'Held Sign', visibility: 'held' }));
  await store.putSign(sign({ id: '01JS0000000000000000000005', title: 'Hidden Sign', visibility: 'hidden' }));
  await store.addWay(way('01JS0000000000000000000001'));
  await store.addWay(
    way('01JS0000000000000000000002', {
      id: 'way-ben',
      playerId: ben.id,
      text: '19 − 12 = 7',
      value: '7',
      createdAt: '2026-03-01T00:00:00.000Z'
    })
  );
  const app = createApp({
    store,
    urls: { site: SITE },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  return { app };
}

/** Every key path in a value, as the docs name them: `place.lat`, `ways[].by`. */
function paths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => paths(v, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const here = prefix ? `${prefix}.${k}` : k;
      // An object documented as a whole (ways[].by) stops there.
      return [here, ...paths(v, here)];
    });
  }
  return [];
}

/** The shared header: every documented field present, nothing undocumented. */
function assertHeader(header: Record<string, unknown>, path: string) {
  assert.deepEqual(undocumented([header], HEADER_FIELDS), []);
  assert.deepEqual(
    HEADER_FIELDS.map(([name]) => name).filter((name) => !paths(header).includes(name)),
    []
  );
  assert.equal(header.url, `${SITE}${path}`);
}

function undocumented(records: unknown[], fields: Field[]): string[] {
  const documented = new Set(fields.map(([name]) => name));
  const covered = (p: string) =>
    documented.has(p) ||
    [...documented].some((d) => p.startsWith(`${d}.`) || p.startsWith(`${d}[]`)) ||
    [...documented].some((d) => d.startsWith(`${p}.`) || d.startsWith(`${p}[]`));
  return [...new Set(records.flatMap((r) => paths(r)))].filter((p) => !covered(p));
}

function assertOpen(res: Response, type: string) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), `${type}; charset=utf-8`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
}

/** No player's email, and nothing held or hidden. */
function assertPublicOnly(body: string) {
  assert.ok(!body.includes(ada.email!), 'no email address');
  assert.ok(!/"email"/.test(body), 'no email field');
  assert.ok(!body.includes('Held Sign') && !body.includes('Hidden Sign'), 'only shown signs');
}

test('signs.json has every shown sign, newest first, with every field documented', async () => {
  const { app } = await setup();
  const res = await app.request('/signs.json');
  assertOpen(res, 'application/json');
  const text = await res.text();
  assertPublicOnly(text);
  const file = JSON.parse(text);
  assert.equal(file.version, 1);
  assert.equal(file.url, `${SITE}/signs.json`);
  assert.equal(file.docs_url, `${SITE}/data`);
  assert.deepEqual(
    file.signs.map((s: { title: string }) => s.title),
    ['Newer Sign', 'Older Sign', 'Nowhere Sign']
  );
  assert.deepEqual(file.counts, { signs: 3, players: 2, states: 1, ways: 2 });
  assert.equal(file.updated, '2026-03-01T00:00:00.000Z');
  const newer = file.signs[0];
  assert.equal(newer.url, `${SITE}/signs/newer-sign`);
  assert.equal(newer.updated_at, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(newer.ways[0].by, { handle: 'ben', name: 'Ben', url: `${SITE}/players/ben` });
  assert.equal(newer.ways[0].tex, '19 - 12 = 7');
  assert.equal(newer.photos[0].url, `${SITE}/p/ph-01JS0000000000000000000002/large.jpg`);
  assert.equal(newer.photos[0].thumb_url, `${SITE}/p/ph-01JS0000000000000000000002/thumb.jpg`);
  assert.deepEqual(newer.finders, [{ name: 'Ada', handle: 'ada', url: `${SITE}/players/ada`, role: 'found' }]);
  assert.equal(file.signs[2].place.lat, null);
  const { signs, ...header } = file;
  assertHeader(header, '/signs.json');
  assert.deepEqual(undocumented(signs, SIGN_FIELDS), []);
});

test('players.json has each player with a page and nothing private', async () => {
  const { app } = await setup();
  const res = await app.request('/players.json');
  assertOpen(res, 'application/json');
  const text = await res.text();
  assertPublicOnly(text);
  const file = JSON.parse(text);
  assert.equal(file.version, 1);
  // Ada found the signs; Ben has a page through the badge his way on her sign earned.
  assert.deepEqual(
    file.players.map((p: { handle: string }) => p.handle),
    ['ada', 'ben']
  );
  const [a, b] = file.players;
  assert.equal(a.bio, 'Counts everything.');
  assert.equal(a.sign_count, 3);
  assert.deepEqual(a.signs, ['newer-sign', 'older-sign', 'nowhere-sign']);
  assert.equal(b.way_count, 1);
  assert.ok(b.badges.length > 0);
  assert.equal(a.feed_url, `${SITE}/players/ada/feed.json`);
  const { players, ...header } = file;
  assertHeader(header, '/players.json');
  assert.deepEqual(undocumented(players, PLAYER_FIELDS), []);
});

test('signs.geojson is a FeatureCollection of the signs with a place', async () => {
  const { app } = await setup();
  const res = await app.request('/signs.geojson');
  assertOpen(res, 'application/geo+json');
  const text = await res.text();
  assertPublicOnly(text);
  const file = JSON.parse(text);
  assert.equal(file.type, 'FeatureCollection');
  assert.equal(file.version, 1);
  const header = Object.fromEntries(Object.entries(file).filter(([k]) => k !== 'type' && k !== 'features'));
  assertHeader(header, '/signs.geojson');
  assert.equal((header.counts as { signs: number }).signs, 3);
  assert.deepEqual(
    file.features.map((f: { properties: { title: string } }) => f.properties.title),
    ['Newer Sign', 'Older Sign']
  );
  const [f] = file.features;
  assert.equal(f.type, 'Feature');
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [-93.27, 44.98] });
  assert.equal(f.properties.math, '19 − 12 = 7');
  assert.deepEqual(
    undocumented(
      file.features.map(({ type: _t, geometry, ...rest }: { type: string; geometry: { coordinates: number[] } }) => ({
        ...rest,
        geometry: { coordinates: geometry.coordinates }
      })),
      GEO_FIELDS
    ),
    []
  );
});

/** Just enough XML checking: every tag that opens closes, in order, and nothing is left loose. */
function wellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(body)) return false;
  const stack: string[] = [];
  for (const [, close, name, self] of body.matchAll(/<(\/?)([\w:]+)(?:\s[^<>]*?)?(\/?)>/g)) {
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0 && !/<(?![\w/?])/.test(body);
}

test('the Atom feed is well formed and carries the shown signs with their photos and math', async () => {
  const { app } = await setup();
  const res = await app.request('/feed.xml');
  assertOpen(res, 'application/atom+xml');
  const xml = await res.text();
  assertPublicOnly(xml);
  assert.ok(wellFormed(xml));
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.ok(xml.includes(`<link href="${SITE}/feed.xml" rel="self" type="application/atom+xml"/>`));
  assert.ok(xml.includes('<updated>2026-03-01T00:00:00.000Z</updated>'));
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  assert.equal(entries.length, 3);
  assert.ok(entries[0].includes(`<id>${SITE}/signs/newer-sign</id>`));
  assert.ok(entries[0].includes('<published>2026-02-01T00:00:00.000Z</published>'));
  assert.ok(entries[0].includes(`<author><name>Ada</name><uri>${SITE}/players/ada</uri></author>`));
  // The content is escaped HTML: the photo, the math and the caption (escaped twice over).
  assert.ok(entries[0].includes('&lt;img src=&quot;https://example.test/p/ph-01JS0000000000000000000002/large.jpg'));
  assert.ok(entries[0].includes('19 − 12 = 7'));
  assert.ok(entries[0].includes('Seen on the way &amp;lt;home&amp;gt; &amp;amp; back'));
  for (const entry of entries) {
    for (const tag of ['title', 'id', 'updated', 'published', 'content', 'summary']) {
      assert.match(entry, new RegExp(`<${tag}[ >]`), `entry has ${tag}`);
    }
  }
});

test('the JSON Feed is JSON Feed 1.1 with the same items', async () => {
  const { app } = await setup();
  const res = await app.request('/feed.json');
  assertOpen(res, 'application/feed+json');
  const text = await res.text();
  assertPublicOnly(text);
  const feed = JSON.parse(text);
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.feed_url, `${SITE}/feed.json`);
  assert.equal(feed.home_page_url, `${SITE}/`);
  assert.equal(feed.items.length, 3);
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  for (const item of feed.items) {
    assert.equal(typeof item.id, 'string');
    assert.ok(item.content_html && item.content_text);
    assert.match(item.date_published, RFC3339);
    assert.match(item.date_modified, RFC3339);
    assert.ok(Array.isArray(item.authors) && item.authors.length);
  }
  const [newer] = feed.items;
  assert.equal(newer.id, `${SITE}/signs/newer-sign`);
  assert.equal(newer.image, `${SITE}/p/ph-01JS0000000000000000000002/large.jpg`);
  assert.equal(newer.summary, '19 − 12 = 7. Found by Ada on January 10, 2026. Testville, Minnesota.');
  assert.deepEqual(newer.tags, ['Minnesota', '2026']);
  assert.ok(newer.content_html.includes('Seen on the way &lt;home&gt; &amp; back'));
});

test('each player with a page has feeds of the signs they found; others are 404', async () => {
  const { app } = await setup();
  const res = await app.request('/players/ada/feed.json');
  assertOpen(res, 'application/feed+json');
  const feed = JSON.parse(await res.text());
  assert.equal(feed.title, 'Ada · Road Sign Math');
  assert.equal(feed.home_page_url, `${SITE}/players/ada`);
  assert.equal(feed.feed_url, `${SITE}/players/ada/feed.json`);
  assert.equal(feed.items.length, 3);
  const atom = await app.request('/players/ada/feed.xml');
  assertOpen(atom, 'application/atom+xml');
  assert.ok(wellFormed(await atom.text()));
  // Ben found no signs: his feed is empty but answers, since his page does.
  assert.equal(JSON.parse(await (await app.request('/players/ben/feed.json')).text()).items.length, 0);
  assert.ok(wellFormed(await (await app.request('/players/ben/feed.xml')).text()));
  assert.equal((await app.request('/players/nobody/feed.json')).status, 404);
  assert.equal((await app.request('/players/nobody/feed.xml')).status, 404);
});

// llmstxt.org's reference parser: prose only above the first "##", then "- [name](url): note" lines.
function llmsShapeProblems(text: string): string[] {
  const LINK_LINE = /^- \[[^\]]+\]\(https?:[^)\s]+\)(: \S.*)?$/;
  const lines = text.split('\n');
  const problems: string[] = [];
  if (!/^# \S/.test(lines[0])) problems.push('line 1: not "# Title"');
  let inSection = false;
  lines.forEach((line, i) => {
    if (line.startsWith('##')) {
      inSection = true;
      return;
    }
    if (i === 0 || line.trim() === '') return;
    if (!inSection) {
      if (line.startsWith('#')) problems.push(`line ${i + 1}: heading above the first ##`);
      return;
    }
    if (!LINK_LINE.test(line)) problems.push(`line ${i + 1}: ${line}`);
    else if (line.split('](').length > 2) problems.push(`line ${i + 1}: two links`);
  });
  return problems;
}

test('llms.txt keeps the llmstxt.org shape and points at the data, feeds and API', async () => {
  const { app } = await setup();
  const res = await app.request('/llms.txt');
  assertOpen(res, 'text/plain');
  const text = await res.text();
  assertPublicOnly(text);
  assert.deepEqual(llmsShapeProblems(text), []);
  for (const path of ['/signs.json', '/players.json', '/signs.geojson', '/feed.xml', '/feed.json', '/data']) {
    assert.ok(text.includes(`](${SITE}${path})`), path);
  }
  assert.ok(text.includes(`](${SITE}/api/v1/openapi.json)`));
  assert.ok(text.includes(`- [Newer Sign](${SITE}/signs/newer-sign): 19 − 12 = 7.`));
  assert.ok(text.includes('- [Nowhere Sign]'));
  const full = await app.request('/llms-full.txt');
  assertOpen(full, 'text/plain');
  const fullText = await full.text();
  assertPublicOnly(fullText);
  assert.ok(fullText.includes('## Newer Sign'));
  assert.ok(fullText.includes('Photo of the Newer Sign sign'));
});

test('the data page documents every file, and the footer, sitemap and robots point to it', async () => {
  const { app } = await setup();
  const res = await app.request('/data');
  assert.equal(res.status, 200);
  const html = await res.text();
  assertPublicOnly(html);
  assert.ok(html.includes('<h1>Feeds and data</h1>'));
  for (const [name] of [...SIGN_FIELDS, ...PLAYER_FIELDS, ...GEO_FIELDS, ...HEADER_FIELDS]) {
    assert.ok(html.includes(`<code>${name}</code>`), name);
  }
  assert.ok(html.includes('<code>GET /api/v1/signs/{id}</code>'));
  assert.ok(!html.includes('GET /api/v1/me'), 'signed-in reads are not listed');
  assert.ok(html.includes('href="/api/v1/openapi.json"'));
  assert.match(await (await app.request('/')).text(), /<a href="\/data">Feeds and data<\/a>/);
  assert.ok((await (await app.request('/sitemap.xml')).text()).includes(`<loc>${SITE}/data</loc>`));
  assert.ok((await (await app.request('/robots.txt')).text()).includes('Allow: /api/v1/openapi.json\n'));
});

test('every page names the feeds for readers, and no non-feed JSON as an alternate', async () => {
  const { app } = await setup();
  const home = await (await app.request('/')).text();
  assert.ok(
    home.includes('<link rel="alternate" type="application/atom+xml" title="Road Sign Math" href="/feed.xml"/>')
  );
  assert.ok(
    home.includes('<link rel="alternate" type="application/feed+json" title="Road Sign Math" href="/feed.json"/>')
  );
  assert.ok(home.includes('<link rel="alternate" type="text/markdown"'));
  assert.ok(!/rel="alternate" type="application\/(geo\+)?json"/.test(home));
  const player = await (await app.request('/players/ada')).text();
  assert.ok(
    player.includes(
      '<link rel="alternate" type="application/atom+xml" title="Ada · Road Sign Math" href="/players/ada/feed.xml"/>'
    )
  );
  assert.ok(player.includes('href="/players/ada/feed.json"'));
});

test('everything shared is CC BY 4.0: every file, the Atom feed, llms.txt, the data and privacy pages say so', async () => {
  const { app } = await setup();
  const cc = 'https://creativecommons.org/licenses/by/4.0/';
  for (const path of ['/signs.json', '/players.json', '/signs.geojson']) {
    const file = (await (await app.request(path)).json()) as { license: { name: string; url: string; credit: string } };
    assert.equal(file.license.name, 'CC BY 4.0', path);
    assert.equal(file.license.url, cc, path);
    assert.ok(file.license.credit.length > 0, path);
  }
  assert.ok((await (await app.request('/feed.xml')).text()).includes(`<rights>CC BY 4.0: ${cc}</rights>`));
  assert.ok((await (await app.request('/llms.txt')).text()).includes(`[Licence](${cc})`));
  for (const path of ['/data', '/privacy']) assert.ok((await (await app.request(path)).text()).includes(cc), path);
});
