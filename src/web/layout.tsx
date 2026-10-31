// The website's frame and the pieces its pages share, as the design draws them: the header with
// the sign-plate logo and Map / Signs / How to play, the footer pointing at the first era's
// archive, avatars, the green sign plate the math sits on, and the map with its pins.

import type { FC, PropsWithChildren } from 'hono/jsx';
import { BADGE_STYLE } from './badges.tsx';
import { mathSvg } from './math.ts';
import { TINYLYTICS_SCRIPT, TINYLYTICS_SITE } from './tinylytics.ts';

export const ARCHIVE_URL = 'https://thingelstad.xyz/things/road-sign-math/';
/** The public TestFlight invite for Jamie's Beta group: the way into the iPhone app until it's on the App Store. */
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/Httdw7ZY';

/** The design's colours, with a dark set beside them. */
const STYLE = `
:root { color-scheme: light dark; --ink: #18201C; --ink2: #3B4540; --soft: #55605A; --line: #D8DED9; --line2: #B9C3BB;
  --rule: #E6EAE6; --page: #FFFFFF; --ground: #F3F5F2; --card: #FFFFFF; --photo: #DDE3DD; --green: #006348;
  --green-dark: #004A36; --green-ink: #006348; --tint: #E3EFE9; --yellow: #F2B300; --heart: #B01C33; --heart-soft: #FBE9EC;
  --chip-on: #18201C; --chip-on-ink: #FFFFFF; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #E8EFEB; --ink2: #C3CEC8; --soft: #9FB0A7; --line: #2C3A33; --line2: #3F5048; --rule: #24302A;
    --page: #101713; --ground: #151E19; --card: #18221D; --photo: #24302A; --green: #006348; --green-dark: #004A36;
    --green-ink: #5CC395; --tint: #CFE3D8; --heart: #E0566B; --heart-soft: #3A1D23; --chip-on: #E8EFEB; --chip-on-ink: #101713; }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.5 Overpass, system-ui, -apple-system, sans-serif; }
a { color: var(--green-ink); }
a:hover { color: var(--ink); }
img { max-width: 100%; }
.wrap { max-width: 1280px; margin: 0 auto; padding-left: 16px; padding-right: 16px; }
@media (min-width: 700px) { .wrap { padding-left: 24px; padding-right: 24px; } }
.mono { font-family: 'Overpass Mono', ui-monospace, monospace; }
.soft { color: var(--soft); }
h1, h2, h3 { font-weight: 900; letter-spacing: -0.01em; }
:focus-visible { outline: 3px solid var(--yellow); outline-offset: 2px; }

.top { border-bottom: 1px solid var(--line); background: var(--page); }
.top .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 28px; padding-top: 10px; padding-bottom: 10px; }
.brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--ink); }
.brand b { font-size: 21px; font-weight: 900; letter-spacing: -0.01em; }
.logo { display: block; flex: 0 0 auto; height: 52px; width: 52px; }
.logo svg { display: block; width: 100%; height: 100%; }
.top nav { display: flex; flex-wrap: wrap; gap: 0 24px; flex: 1 1 auto; font-weight: 700; order: 3; width: 100%; }
.top nav a { color: var(--ink); text-decoration: none; padding: 10px 0; border-bottom: 3px solid transparent; }
.top nav a[aria-current] { border-bottom-color: var(--green); }
@media (min-width: 760px) { .top nav { order: 0; width: auto; } }
.get { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 10px;
  background: var(--green); color: #fff; font-weight: 800; text-decoration: none; margin-left: auto; }
.get:hover { background: var(--green-dark); color: #fff; }

.foot { border-top: 1px solid var(--line); }
.foot .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 28px; padding-top: 28px; padding-bottom: 40px;
  font-size: 15px; color: var(--ink2); }
.foot p { margin: 0; flex: 1 1 320px; line-height: 1.5; }
.foot .logo { height: 40px; width: 40px; }
.foot nav { display: flex; gap: 20px; font-weight: 700; }

.avatar { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
  color: #fff; font-weight: 900; width: 36px; height: 36px; }
.avatar.ink { color: #18201C; }
.avatar.photo { overflow: hidden; background: var(--line); }
.avatar.photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
.plate { background: var(--green); border-radius: 14px; padding: 4px; }
.plate > span { display: block; border: 2.5px solid #fff; border-radius: 10px; padding: 12px; color: #fff; text-align: center;
  font-weight: 800; font-size: 21px; line-height: 1.3; overflow-x: auto; }
.plate svg { max-width: 100%; height: auto; vertical-align: middle; }
.eq { font-weight: 700; color: var(--green-ink); }

.map { position: relative; width: 100%; aspect-ratio: 975 / 610; background: var(--card); border: 1px solid var(--line);
  border-radius: 16px; overflow: hidden; }
.map > img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.pin { position: absolute; transform: translate(-50%, -50%); width: 24px; height: 24px; padding: 0; border-radius: 50%;
  border: 3px solid #fff; background: var(--green); color: #fff; font: inherit; font-size: 14px; font-weight: 900; line-height: 1;
  display: flex; align-items: center; justify-content: center; text-decoration: none; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.pin.many { width: 32px; height: 32px; }
.pin:hover { color: #fff; background: var(--green-dark); }
.pin[aria-current], .pin.on { box-shadow: 0 0 0 3px var(--yellow), 0 2px 6px rgba(0,0,0,.4); z-index: 1; }
/* On a phone the map is a third the size, so the dots shrink to stay apart. */
@media (max-width: 599px) { .pin { width: 16px; height: 16px; border-width: 2px; font-size: 11px; } .pin.many { width: 22px; height: 22px; } }
/* A bigger target than the dot, for fingers. */
.pin::after { content: ''; position: absolute; inset: -10px; border-radius: 50%; }

.tiles { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 28px 20px; }
.tile > a { display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: var(--ink); }
.tile .shot { position: relative; display: block; }
.tile img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 12px; display: block; background: var(--photo); }
.tile .words { display: flex; flex-direction: column; gap: 2px; }
.tile strong { font-size: 17px; }
.tile .eq { font-size: 15px; }
.tile .soft { font-size: 14px; }
.tile .heart { margin-top: 8px; }
.tile .eq { overflow-wrap: anywhere; }
@media (max-width: 599px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 12px; } .tile strong { font-size: 15px; } .tile .eq { font-size: 14px; } .tile .soft { font-size: 13px; } }
.dist { position: absolute; left: 10px; top: 10px; padding: 3px 9px 1px; border-radius: 8px; background: #fff; color: #18201C;
  font-size: 13px; font-weight: 700; }

${BADGE_STYLE}`;

/** The heart buttons, only on pages that load Tinylytics' script (it fills them in). */
const HEART_STYLE = `.tinylytics_kudos { font: inherit; font-size: 15px; line-height: 1; color: var(--ink); background: transparent;
  border: 1px solid var(--line2); border-radius: 999px; padding: 7px 12px; min-width: 56px; min-height: 36px; cursor: pointer; }
.tinylytics_kudos:empty::before { content: "❤️"; opacity: .45; }
.tinylytics_kudos:hover { border-color: var(--heart); }
.tinylytics_kudos.did_select { border-color: var(--heart); background: var(--heart-soft); cursor: default; }
`;

export type PageMeta = {
  title: string;
  description: string;
  /** The page's own address, for sharing. */
  url?: string;
  /** A photo to show when the page is shared. */
  image?: string;
  /** Which of Map, Signs and How to play the page is under. */
  here?: 'map' | 'signs' | 'how';
  /** Adds Tinylytics' counter. The sign-in page leaves it out: its URL carries the link's token. */
  count?: boolean;
  /** Page-only CSS. */
  style?: string;
  /** A small script of the page's own, run after it loads. */
  script?: string;
};

let logoMarkup: string | undefined;
/** The design's logo, √(5 − 1) = 2 (the Twin Lakes sign) on a sign plate, as one SVG. */
export const logoSvg = (): string => {
  if (logoMarkup === undefined) {
    const math = mathSvg('\\sqrt{5 - 1} = 2');
    const box = /viewBox="([^"]+)"/.exec(math)?.[1] ?? '0 0 100 40';
    const inner = math.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    logoMarkup =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="12" fill="#006348"/>` +
      `<rect x="5.5" y="5.5" width="53" height="53" rx="8.5" fill="none" stroke="#fff" stroke-width="3"/>` +
      `<svg x="11" y="22" width="42" height="20" viewBox="${box}" color="#fff">${inner}</svg></svg>`;
  }
  return logoMarkup;
};

export const Logo: FC = () => <span class="logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logoSvg() }} />;

const Phone: FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="6" y="2" width="12" height="20" rx="3" />
    <path d="M11 18h2" />
  </svg>
);
export { Phone };

export const Page: FC<PropsWithChildren<PageMeta>> = ({
  title,
  description,
  url,
  image,
  here,
  count = true,
  style = '',
  script,
  children
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="theme-color" content="#006348" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      {url && <link rel="canonical" href={url} />}
      <meta property="og:site_name" content="Road Sign Math" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {url && <meta property="og:url" content={url} />}
      {image && <meta property="og:image" content={image} />}
      <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800;900&family=Overpass+Mono:wght@400;700&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: STYLE + (count ? HEART_STYLE : '') + style }} />
    </head>
    <body>
      <header class="top">
        <div class="wrap">
          <a class="brand" href="/">
            <Logo />
            <b>Road Sign Math</b>
          </a>
          <nav aria-label="Main">
            <a href="/#map" aria-current={here === 'map' ? 'page' : undefined}>
              Map
            </a>
            <a href="/#latest" aria-current={here === 'signs' ? 'page' : undefined}>
              Signs
            </a>
            <a href="/#how" aria-current={here === 'how' ? 'page' : undefined}>
              How to play
            </a>
          </nav>
          <a class="get" href="/#app">
            <Phone />
            Get the app
          </a>
        </div>
      </header>
      {children}
      <footer class="foot">
        <div class="wrap">
          <Logo />
          <p>
            Road Sign Math was created by Jamie Thingelstad in 2005. The first era’s signs, 2005 to 2014, are kept in{' '}
            <a href={ARCHIVE_URL} style="font-weight: 700">
              the archive on Things I’ve built
            </a>
            .
          </p>
          <p>
            <a href="/privacy">Privacy</a>
          </p>
        </div>
      </footer>
      {script && <script dangerouslySetInnerHTML={{ __html: script }} />}
      {count && <script defer src={TINYLYTICS_SCRIPT} data-site={TINYLYTICS_SITE} />}
    </body>
  </html>
);

/**
 * A round avatar: the player's profile photo (`photo`, its id) when they set one, or their first
 * letter in their colour. Yellow takes ink, as the design does.
 */
export const Avatar: FC<{ name: string; color?: string; size?: number; photo?: string }> = ({
  name,
  color = '#006348',
  size = 36,
  photo
}) =>
  photo ? (
    <span aria-hidden="true" class="avatar photo" style={`width: ${size}px; height: ${size}px`}>
      <img src={`/p/${photo}/${size > 64 ? 'large' : 'thumb'}.jpg`} alt="" loading="lazy" />
    </span>
  ) : (
    <span
      aria-hidden="true"
      class={color.toUpperCase() === '#F2B300' ? 'avatar ink' : 'avatar'}
      style={`background: ${color}; width: ${size}px; height: ${size}px; font-size: ${Math.round(size * 0.42)}px`}
    >
      {[...(name.trim() || '?')][0].toUpperCase()}
    </span>
  );

/** A way's math on the sign plate, drawn from its LaTeX; the plain text when there is none. */
export const Plate: FC<{ way: { text: string; tex: string | null } }> = ({ way }) => (
  <div class="plate">
    {way.tex === null ? (
      <span>{way.text}</span>
    ) : (
      <span role="img" aria-label={way.text} dangerouslySetInnerHTML={{ __html: mathSvg(way.tex) }} />
    )}
  </div>
);

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "Sep 1, 2025" for a YYYY-MM-DD day. */
export const shortDay = (day: string): string => DAY.format(new Date(`${day}T00:00:00Z`));
/** "September 1, 2025". */
export const longDay = (day: string): string => LONG_DAY.format(new Date(`${day}T00:00:00Z`));
