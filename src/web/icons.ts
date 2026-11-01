// The site's icons beside /favicon.svg, all drawn from the logo: /favicon.ico for browsers and
// readers that ask for it by name, /apple-touch-icon.png for an iPhone's home screen (corners
// filled, since iOS rounds them itself), and the web manifest with its two PNG sizes. Rendered
// with sharp on first ask and kept for the life of the instance.

import type { Context, Hono } from 'hono';
import sharp from 'sharp';
import { logoSvg } from './layout.tsx';

const DAY = 'public, max-age=86400';
/** The sizes /favicon.ico holds, smallest first. */
export const ICO_SIZES = [16, 32, 48] as const;

/** The logo drawn at `size` pixels square: the SVG is 64 units, so it's rasterised at that scale, not stretched. */
const png = async (size: number, square = false): Promise<Buffer> => {
  let image = sharp(Buffer.from(logoSvg(square)), { density: (72 * size) / 64 }).resize(size, size);
  if (square) image = image.flatten({ background: '#006348' });
  return image.png().toBuffer();
};

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
      png(180, true),
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

/** The manifest: the name, colours and icons a phone uses when the site is added to its home screen. */
export const MANIFEST = {
  name: 'Road Sign Math',
  short_name: 'Road Sign Math',
  description: 'Road signs whose numbers make true math, found on road trips and posted from the iPhone app.',
  start_url: '/',
  display: 'browser',
  background_color: '#FFFFFF',
  theme_color: '#006348',
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
