// The site's icons beside /favicon.svg, all drawn from the identity's Highway icon (brand.ts, the
// package's icons/svg/highway.svg): /favicon.ico for browsers and readers that ask for it by name,
// /apple-touch-icon.png for an iPhone's home screen, and the web manifest with its two PNG sizes.
// Each is the whole square canvas, opaque, corners filled: a phone rounds them itself, and the
// package asks for the complete canvas, never the symbol resized within it. Rendered with sharp on
// first ask and kept for the life of the instance.

import type { Context, Hono } from 'hono';
import sharp from 'sharp';
import { HIGHWAY_SVG } from './brand.ts';

const DAY = 'public, max-age=86400';
/** The sizes /favicon.ico holds, smallest first. */
export const ICO_SIZES = [16, 32, 48] as const;

/** Highway green, the icon's ground and the manifest's theme. */
const GREEN = '#006348';

/** The icon drawn at `size` pixels square: the SVG is 1024 units, so it's rasterised at that scale, not stretched. */
const png = (size: number): Promise<Buffer> =>
  sharp(Buffer.from(HIGHWAY_SVG), { density: (72 * size) / 1024 })
    .resize(size, size)
    .flatten({ background: GREEN })
    .png()
    .toBuffer();

/** An .ico file holding PNG images, which every browser since Internet Explorer 9 reads. */
export const icoOf = (images: { size: number; png: Buffer }[]): Buffer => {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
};

type Icons = { ico: Buffer; touch: Buffer; 192: Buffer; 512: Buffer };
let made: Promise<Icons> | undefined;
const icons = (): Promise<Icons> => {
  made ??= (async () => {
    const [touch, small, large, ...ico] = await Promise.all([
      png(180),
      png(192),
      png(512),
      ...ICO_SIZES.map((size) => png(size))
    ]);
    return { ico: icoOf(ICO_SIZES.map((size, i) => ({ size, png: ico[i] }))), touch, 192: small, 512: large };
  })().catch((err: unknown) => {
    made = undefined;
    throw err;
  });
  return made;
};

/**
 * The manifest: the name, colours and icons a phone uses when the site is added to its home screen.
 * The icons are `any`, not `maskable`: Highway's mark reaches 490 of the canvas's 512 units out from
 * the middle, past the circle of 410 a maskable icon keeps safe, so a round mask would cut it.
 */
export const MANIFEST = {
  name: 'Road Sign Math',
  short_name: 'Road Sign Math',
  description: 'Road signs whose numbers make true math, found on road trips and posted from the iPhone app.',
  start_url: '/',
  display: 'browser',
  background_color: '#FFFFFF',
  theme_color: GREEN,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }
  ]
} as const;

export function mountIcons(site: Hono): void {
  const serve = (pick: (i: Icons) => Buffer, type: string) => async (c: Context) =>
    c.body(new Uint8Array(pick(await icons())), 200, { 'Content-Type': type, 'Cache-Control': DAY });
  site.get(
    '/favicon.ico',
    serve((i) => i.ico, 'image/x-icon')
  );
  site.get(
    '/apple-touch-icon.png',
    serve((i) => i.touch, 'image/png')
  );
  // Older iOS asks for this name first.
  site.get(
    '/apple-touch-icon-precomposed.png',
    serve((i) => i.touch, 'image/png')
  );
  site.get(
    '/icon-192.png',
    serve((i) => i[192], 'image/png')
  );
  site.get(
    '/icon-512.png',
    serve((i) => i[512], 'image/png')
  );
  site.get('/site.webmanifest', (c) =>
    c.body(JSON.stringify(MANIFEST), 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': DAY })
  );
}
