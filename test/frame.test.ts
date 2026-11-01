import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign } from '../src/store/store.ts';
import { BRAND_FILES, BRAND_VERSION, HIGHWAY_SVG, LOCKUP_SIZE } from '../src/web/brand.ts';
import { ICO_SIZES, MANIFEST } from '../src/web/icons.ts';
import { ada, ben, sign } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

const id = (n: number) => `01JS${String(n).padStart(22, '0')}`;

/** Four shown signs, posted a day apart, and one held back. */
async function setup(store = new MemoryStore()) {
  for (const p of [ada, ben]) await addPlayer(store, p);
  for (const n of [1, 2, 3, 4]) {
    await addSign(
      store,
      sign({ id: id(n), title: `Sign ${n}`, foundOn: `2026-01-0${n}`, postedAt: `2026-01-0${n}T12:00:00.000Z` })
    );
  }
  await addSign(
    store,
    sign({ id: id(5), title: 'Held Back', postedAt: '2026-01-09T12:00:00.000Z', visibility: 'held' })
  );
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator()
  });
  const page = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    return { res, html: await res.text() };
  };
  return { app, page };
}

test('an address with no page answers 404 with the way back and the three newest signs', async () => {
  const { page } = await setup();
  for (const path of ['/nowhere', '/signs/no-such-sign', '/players/nobody']) {
    const { res, html } = await page(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(html, /<h1>This road doesn’t go anywhere\.<\/h1>/);
    assert.ok(html.includes(`There’s no page at <code class="mono">${path}</code>.`), path);
    assert.match(html, /<div class="plate"><span role="img" aria-label="404 = 4 × 101"><svg /);
    assert.match(
      html,
      /<a href="\/"><span aria-hidden="true">←<\/span> Back to the map<\/a><a href="\/signs">See every sign<\/a>/
    );
    const newest = [...html.matchAll(/<li><a href="\/signs\/([^"]+)">/g)].map((m) => m[1]);
    assert.deepEqual(newest, ['sign-4', 'sign-3', 'sign-2'], path);
    assert.ok(!html.includes('Held Back'));
  }
});

test('the 404 page repeats the address escaped, and cut short when it is long', async () => {
  const { html } = await setup().then(({ page }) => page('/%3Cscript%3Ealert(1)%3C/script%3E'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  const long = await setup().then(({ page }) => page(`/${'x'.repeat(300)}`));
  assert.ok(long.html.includes(`<code class="mono">/${'x'.repeat(119)}…</code>`));
});

test('the 404 page still answers when the signs cannot be read', async () => {
  const store = new MemoryStore();
  const { page } = await setup(store);
  store.allSigns = () => Promise.reject(new Error('table down'));
  const errors = console.error;
  console.error = () => {};
  try {
    const { res, html } = await page('/nowhere');
    assert.equal(res.status, 404);
    assert.match(html, /<h1>This road doesn’t go anywhere\.<\/h1>/);
    assert.ok(!html.includes('Or try one of the newest'));
  } finally {
    console.error = errors;
  }
});

test('a page asked for with a trailing slash goes to the address without it', async () => {
  const { page } = await setup();
  for (const [from, to] of [
    ['/signs/', '/signs'],
    ['/signs/sign-1/?sort=latest', '/signs/sign-1?sort=latest'],
    ['/about//', '/about'],
    ['/nowhere/', '/nowhere']
  ]) {
    const { res } = await page(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  }
  // Never off the site: "//host/" would be another site's address.
  for (const path of ['//evil.example/', '/\\evil.example/']) {
    const { res } = await page(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('location'), null);
  }
  // Only reads are sent on; the API's 404s stay JSON.
  assert.equal((await page('/signs/', { method: 'POST' })).res.status, 404);
  const api = await page('/api/v1/nope/');
  assert.equal(api.res.status, 404);
  assert.deepEqual(JSON.parse(api.html), { error: { code: 'not_found', message: 'No such route' } });
});

/** The identity package the site's logo and icons come from (design/brand/v1). */
const PACKAGE = new URL(`../design/brand/${BRAND_VERSION}/`, import.meta.url);
const fromPackage = (path: string) => readFile(new URL(path, PACKAGE), 'utf8');

/** Opaque, square, and Highway green in every corner: a phone rounds the corners itself. */
async function assertFullCanvas(png: Buffer, size: number, label: string) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [size, size, 3], label);
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1]
  ]) {
    const at = (y * size + x) * 3;
    assert.deepEqual([...data.subarray(at, at + 3)], [0x00, 0x63, 0x48], `${label} corner ${x},${y}`);
  }
}

test('the site’s logo and icon are the identity package’s files, byte for byte', async () => {
  const manifest = JSON.parse(await fromPackage('manifest.json')) as { version: string; default: string };
  assert.equal(BRAND_VERSION, `v${manifest.version.split('.')[0]}`);
  assert.equal(manifest.default, 'highway');
  assert.equal(HIGHWAY_SVG, await fromPackage('icons/svg/highway.svg'));
  for (const [file, body] of Object.entries(BRAND_FILES)) assert.equal(body, await fromPackage(`logo/${file}`), file);
  assert.match(
    BRAND_FILES['lockup-horizontal-color.svg'],
    new RegExp(`viewBox="0 0 ${LOCKUP_SIZE.width} ${LOCKUP_SIZE.height}"`)
  );
});

test('the header and footer show the horizontal logo, colour on light and white on dark', async () => {
  const { app, page } = await setup();
  for (const file of Object.keys(BRAND_FILES)) {
    const res = await app.request(`/brand/${BRAND_VERSION}/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml', file);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400', file);
    assert.equal(await res.text(), BRAND_FILES[file as keyof typeof BRAND_FILES], file);
  }
  // Only the two logos the site shows are served, not the rest of the package.
  for (const file of ['lockup-stacked-green.svg', 'mark-green.svg', 'nope.svg']) {
    assert.equal((await app.request(`/brand/${BRAND_VERSION}/${file}`)).status, 404, file);
  }

  const lockup = (alt: string, height: number) =>
    `<picture class="lockup"><source srcset="/brand/${BRAND_VERSION}/lockup-horizontal-white.svg" media="(prefers-color-scheme: dark)"/>` +
    `<img src="/brand/${BRAND_VERSION}/lockup-horizontal-color.svg" alt="${alt}" width="${Math.round((LOCKUP_SIZE.width * height) / LOCKUP_SIZE.height)}" height="${height}"/></picture>`;
  for (const path of ['/', '/signs/sign-1', '/about', '/nowhere']) {
    const { html } = await page(path);
    // The header's link home is named by the logo's alt text, the site's name.
    assert.ok(html.includes(`<a class="brand" href="/">${lockup('Road Sign Math', 44)}</a>`), path);
    // The footer's says nothing: the sentence beside it starts with the name.
    assert.ok(
      html.includes(`<footer class="foot"><div class="wrap">${lockup('', 32)}<p>Road Sign Math was created`),
      path
    );
    // The files are pictures, not inline: their ids (title, radical-route) never land in the page twice.
    assert.ok(!html.includes('radical-route'), path);
  }
});

test('icons: favicon.svg is the Highway icon, and favicon.ico, the home screen icon and the manifest are drawn from it', async () => {
  const { app, page } = await setup();
  const bytes = async (path: string) => {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400', path);
    return { type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
  };
  const svg = await bytes('/favicon.svg');
  assert.equal(svg.type, 'image/svg+xml');
  assert.equal(svg.body.toString(), await fromPackage('icons/svg/highway.svg'));
  const ico = await bytes('/favicon.ico');
  assert.equal(ico.type, 'image/x-icon');
  assert.deepEqual([...ico.body.subarray(0, 6)], [0, 0, 1, 0, ICO_SIZES.length, 0]);
  for (const [i, size] of ICO_SIZES.entries()) {
    const at = 6 + 16 * i;
    assert.equal(ico.body[at], size);
    const png = ico.body.subarray(
      ico.body.readUInt32LE(at + 12),
      ico.body.readUInt32LE(at + 12) + ico.body.readUInt32LE(at + 8)
    );
    assert.equal((await sharp(png).metadata()).format, 'png');
    await assertFullCanvas(png, size, `favicon.ico ${size}`);
  }
  for (const [path, size] of [
    ['/apple-touch-icon.png', 180],
    ['/apple-touch-icon-precomposed.png', 180],
    ['/icon-192.png', 192],
    ['/icon-512.png', 512]
  ] as const) {
    const icon = await bytes(path);
    assert.equal(icon.type, 'image/png');
    // Every one fills its corners: iOS rounds the home screen icon itself and would show black.
    await assertFullCanvas(icon.body, size, path);
  }
  // At full size the drawing is the package's own PNG, pixel for pixel.
  const [drawn, supplied] = await Promise.all([
    sharp(Buffer.from(HIGHWAY_SVG), { density: 72 }).flatten({ background: '#006348' }).raw().toBuffer(),
    readFile(new URL('icons/png-1024/highway.png', PACKAGE)).then((png) => sharp(png).removeAlpha().raw().toBuffer())
  ]);
  assert.ok(drawn.equals(supplied));
  const manifest = await bytes('/site.webmanifest');
  assert.equal(manifest.type, 'application/manifest+json');
  assert.deepEqual(JSON.parse(manifest.body.toString()), MANIFEST);
  for (const icon of MANIFEST.icons) assert.equal((await app.request(icon.src)).status, 200, icon.src);
  // Highway's mark runs past a maskable icon's safe circle, so none is offered for a round mask.
  assert.ok(MANIFEST.icons.every((icon) => !('purpose' in icon)));
  assert.equal(MANIFEST.theme_color, '#006348');

  const { html } = await page('/');
  for (const link of [
    '<link rel="icon" href="/favicon.ico" sizes="48x48"/>',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>',
    '<link rel="manifest" href="/site.webmanifest"/>'
  ]) {
    assert.ok(html.includes(link), link);
  }
});

test('every page starts with a skip link to its one main, and the footer names the licence', async () => {
  const { page } = await setup();
  for (const path of [
    '/',
    '/signs',
    '/signs/sign-1',
    '/players',
    '/players/ada',
    '/app',
    '/about',
    '/privacy',
    '/data',
    '/signin',
    '/nowhere'
  ]) {
    const { html } = await page(path);
    assert.match(html, /<body><a class="skip" href="#main">Skip to content<\/a><header class="top">/, path);
    assert.equal(html.match(/<main[ >]/g)?.length, 1, path);
    assert.equal(html.match(/ id="main"/g)?.length, 1, path);
    assert.match(html, /<main id="main"/, path);
    assert.match(
      html,
      /Signs and photos are shared under <a href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/" rel="license" style="font-weight: 700">CC BY 4\.0<\/a>\./,
      path
    );
  }
});
