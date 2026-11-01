/**
 * Makes src/web/app-assets.ts, what the /app page shows that isn't text: three screens of the
 * iPhone app as WebP, and the QR code for the TestFlight invite as SVG. The bundle has no folder
 * of files, so they go in as a module.
 *
 *   npm run app-assets -- <camera> <sign> <home>
 *
 * Each is a screenshot of the app (PNG or JPEG, made 414 px wide): the Check the numbers
 * screen, a sign's page, and Home. This repo is public: look at each one before it goes in.
 * Run it again when TESTFLIGHT_URL changes; a test checks the code was made for it.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { TESTFLIGHT_URL } from '../src/web/layout.tsx';

const names = ['camera', 'sign', 'home'] as const;
const paths = process.argv.slice(2);
if (paths.length !== names.length) {
  console.error('npm run app-assets -- <camera> <sign> <home>');
  process.exit(1);
}

const shots = await Promise.all(
  paths.map(async (path) => {
    const { data, info } = await sharp(path)
      .resize({ width: 414 })
      .webp({ quality: 74 })
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, webp: data.toString('base64') };
  })
);

const qr = (
  await QRCode.toString(TESTFLIGHT_URL, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#18201C', light: '#FFFFFF' }
  })
).trim();

const out =
  `// Made by tools/app-assets.ts (npm run app-assets); don't edit by hand.\n\n` +
  `/** Screens of the iPhone app for the /app page, as base64 WebP. */\n` +
  `export const APP_SHOTS = {\n` +
  names.map((name, i) => `  ${name}: ${JSON.stringify(shots[i])}`).join(',\n') +
  `\n} as const;\n\n` +
  `/** The address the QR code below was made for. */\n` +
  `export const BETA_QR_FOR = ${JSON.stringify(TESTFLIGHT_URL)};\n\n` +
  `/** The QR code for the TestFlight invite. */\n` +
  `export const BETA_QR_SVG = ${JSON.stringify(qr)};\n`;
await writeFile('src/web/app-assets.ts', out);
execFileSync('node_modules/.bin/prettier', ['--write', 'src/web/app-assets.ts'], { stdio: 'ignore' });
console.log(
  `src/web/app-assets.ts: ${shots.map((s, i) => `${names[i]} ${s.width}x${s.height} ${Math.round((s.webp.length * 3) / 4 / 1024)} KB`).join(', ')}`
);
