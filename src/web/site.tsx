// The website, as the design draws it: Home (the map of every sign, who's playing, the latest
// signs, how to play, the app), a page per sign and a page per player with their badges.
// Read-only, public, cached at the edge until a page changes (src/edge-cache.ts), and built from
// the same store and views as the API. There is no sign-in here: posting and finding another way happen in the app.

import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { earnedBadges } from '../domain/badges.ts';
import { texOf } from '../domain/equation.ts';
import { miles, STATES } from '../domain/geo.ts';
import type { CoFind, Player, Sign, Way } from '../domain/types.ts';
import {
  byNewest,
  earnedBadgeView,
  isPublic,
  photoUrl,
  playerStats,
  signDetail,
  signSummary,
  type People,
  type Urls
} from '../api/views.ts';
import { BADGE_STYLE, BadgeCards, YearPlates } from './badges.tsx';
import { BIMI_SVG, BRAND_FILES, HIGHWAY_SVG } from './brand.ts';
import { CHIP_STYLE, Eq, Facts, finderNames, Heart, Sep, SORT_NOTES, SortChips, Tile } from './cards.tsx';
import {
  APP_STORE_URL,
  AppStoreBadge,
  ARCHIVE_URL,
  Avatar,
  BetaLink,
  brandUrl,
  FOLLOW,
  Page,
  Plate,
  shortDay
} from './layout.tsx';
import { HOME_MAP_SCRIPT, HOME_MAP_STYLE } from './home-map.ts';
import { cluster, clusterName, countSigns, project, type Cluster } from './map.ts';
import { mathSvg } from './math.ts';
import { feedAlternates } from './feeds.ts';
import { createOldLinks } from './old-links.ts';
import { createOpenWeb } from './open.tsx';
import { homeCard, pinValue, playerCard, signCard } from './share.ts';
import { mountAppPage } from './app-page.tsx';
import { mountIcons } from './icons.ts';
import { mountPlayers, playingSince } from './players.tsx';
import { credits, solveOf, type Solve } from '../quiz/data.ts';
import { QUIZ_OPEN } from '../quiz/quiz.tsx';
import { mountSigns } from './signs.tsx';
import { sortOf } from './sorts.ts';
import { PAGE_CACHE, POPULAR_CACHE } from '../edge-cache.ts';
import { US_BORDERS, US_LAND, US_MAP_SIZE } from './us-map.ts';

type Summary = ReturnType<typeof signSummary>;

/** The map's picture: the country and its state lines, light and dark. */
const US_MAP_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${US_MAP_SIZE.width} ${US_MAP_SIZE.height}">` +
  `<style>.l{fill:#DCE4DE}.b{fill:none;stroke:#FFFFFF;stroke-width:1.2;stroke-linejoin:round}` +
  `@media (prefers-color-scheme:dark){.l{fill:#2A3831}.b{stroke:#18221D}}</style>` +
  `<path class="l" d="${US_LAND}"/><path class="b" d="${US_BORDERS}"/></svg>`;

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The finders by name, each player's name a link to their page. */
const Finders: FC<{ sign: Summary }> = ({ sign }) => (
  <>
    {sign.finders.map((f, i) => (
      <>
        {i > 0 && ', '}
        {f.handle ? <a href={`/players/${f.handle}`}>{f.name}</a> : f.name}
      </>
    ))}
  </>
);

/** The pins, as links: `href` says where each one goes. */
const Pins: FC<{ clusters: Cluster[]; href: (c: Cluster) => string; on?: string }> = ({ clusters, href, on }) => (
  <>
    {clusters.map((c) => (
      <a
        class={c.signs.length > 1 ? 'pin many' : 'pin'}
        href={href(c)}
        style={`left: ${c.x.toFixed(2)}%; top: ${c.y.toFixed(2)}%`}
        aria-label={`${clusterName(c)}: ${countSigns(c.signs.length)}`}
        aria-current={c.key === on ? 'true' : undefined}
        data-map=""
      >
        {c.signs.length > 1 ? String(c.signs.length) : ''}
      </a>
    ))}
  </>
);

/**
 * Signs the picture can't place. One with a place (off the picture, like a sign abroad) is marked
 * `data-onmap`: Home's moving map places it, and its script takes it off this list.
 */
const NoPin: FC<{ signs: Sign[]; byYear?: boolean; year?: string }> = ({ signs, byYear, year }) => {
  // Home lists every year's, each marked with its year and hidden outside the year shown, so its
  // moving map can follow the year chips without asking the server again.
  const off = (s: Sign) => year !== undefined && s.foundOn.slice(0, 4) !== year;
  const tag = (s: Sign) => (byYear ? s.foundOn.slice(0, 4) : undefined);
  return signs.length ? (
    <p class="nopin soft" hidden={signs.every(off) ? true : undefined}>
      Not on the map:{' '}
      {signs.map((s) => (
        <span
          class="np"
          data-year={tag(s)}
          data-onmap={s.place.lat !== undefined && s.place.lng !== undefined ? '' : undefined}
          hidden={off(s) ? true : undefined}
        >
          <a href={`/signs/${s.slug}`}>{s.title}</a> ({s.place.label})
        </span>
      ))}
      .
    </p>
  ) : (
    <></>
  );
};

const ABOUT_STYLE = `
.about { padding-top: 32px; padding-bottom: 56px; max-width: 760px; }
.about .lead { font-size: 20px; line-height: 1.45; color: var(--ink2); }
.about h2 { margin-top: 40px; }
.about .first { display: grid; grid-template-columns: minmax(0, 300px) 1fr; gap: 24px; align-items: center; }
.about .first p { margin: 0; }
.about .shot { display: grid; gap: 10px; text-decoration: none; }
.about .shot img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 12px; background: var(--photo); }
@media (max-width: 599px) { .about .first { grid-template-columns: 1fr; } .about .first > .shot, .about .first > .plate { max-width: 360px; } }
.eras { margin: 0; padding: 0; list-style: none; display: grid; gap: 28px; }
.eras li { border-left: 4px solid var(--green); padding-left: 18px; }
.eras .when { display: inline-block; font-size: 14px; font-weight: 700; color: var(--green-ink); }
.eras h3 { margin: 2px 0 6px; font-size: 21px; }
.eras p { margin: 0; }
`;

/** Things I've built, where each era of the game has its page. */
const THINGS_URL = 'https://thingelstad.xyz/things/';

/** Signs in Home's list; the rest are a click away on /signs. */
const HOME_SIGNS = 12;
/** Players in Home's Who's playing; the rest are a click away on /players. */
const HOME_PLAYERS = 10;

/** The list of signs off the map: a separator between the entries shown. */
const NOPIN_STYLE = `
.nopin[hidden], .nopin .np[hidden] { display: none; }
.nopin .np:not([hidden]) ~ .np:not([hidden])::before { content: '; '; }
`;

const HOME_STYLE = `
.hero { background: var(--ground); border-bottom: 1px solid var(--line); scroll-margin-top: 0; }
/* One column on a phone, in the order it reads: the pitch, the map, then who's playing. Side by side, the
   players sit under the pitch and the map runs down the right. */
.hero > .wrap { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "intro" "map" "who";
  gap: 28px 32px; align-items: start; padding-top: 28px; padding-bottom: 36px; }
@media (min-width: 940px) {
  .hero > .wrap { grid-template-columns: minmax(300px, 360px) minmax(0, 1fr); grid-template-rows: auto 1fr;
    grid-template-areas: "intro map" "who map"; row-gap: 18px; }
}
.intro { grid-area: intro; max-width: 360px; display: flex; flex-direction: column; gap: 18px; }
.kicker { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--soft); }
.intro h1 { margin: 0; font-size: clamp(36px, 7vw, 46px); line-height: 1.02; letter-spacing: -0.02em; }
.intro > p { margin: 0; font-size: 18px; color: var(--ink2); }
.stats { margin: 0; display: flex; gap: 28px; }
.stats div { display: flex; flex-direction: column; }
.stats dd { margin: 0; order: 1; font-size: 30px; font-weight: 700; }
.stats dt { order: 2; font-size: 14px; color: var(--soft); }
.who { grid-area: who; max-width: 360px; }
.who h2 { margin: 0 0 4px; font-size: 14px; font-weight: 800; letter-spacing: 0; }
.who ul { margin: 0; padding: 0; list-style: none; }
.who a { display: flex; align-items: center; gap: 12px; min-height: 48px; text-decoration: none; color: var(--ink); }
.who a b { flex: 1; text-decoration: underline; text-decoration-color: var(--line2); text-underline-offset: 3px; }
.who a span.soft { font-size: 14px; }
.who .everyone { display: inline-block; margin-top: 6px; font-weight: 800; }
#map-panel { grid-area: map; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.years { display: flex; flex-wrap: wrap; gap: 8px; }
.years a { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 999px;
  border: 1.5px solid var(--line2); background: var(--card); color: var(--ink); font-weight: 700; font-size: 14px; text-decoration: none; }
.years a[aria-current] { border-color: var(--chip-on); background: var(--chip-on); color: var(--chip-on-ink); }
.picked { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.picked h2 { margin: 0; font-size: 18px; }
.picked ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 10px 18px; }
.picked a { display: flex; align-items: center; gap: 12px; min-height: 64px; text-decoration: none; color: var(--ink); }
.picked img { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; display: block; flex: 0 0 auto; background: var(--photo); }
.picked .words { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.picked .eq { font-size: 14px; }
.picked .soft { font-size: 13px; }
.nopin { margin: 0; font-size: 14px; }
${NOPIN_STYLE}
.band > .wrap { padding-top: 44px; padding-bottom: 48px; display: flex; flex-direction: column; gap: 20px; }
.band h2 { margin: 0; font-size: 32px; }
.band .lede { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
.band .lede p { margin: 0; flex: 1; color: var(--soft); }
.band .lede h2 { margin-right: 12px; }
.sortline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: -8px; }
.all { align-self: flex-start; display: inline-flex; align-items: center; min-height: 48px; padding: 0 20px; border-radius: 10px;
  border: 1.5px solid var(--line2); font-weight: 800; color: var(--ink); text-decoration: none; }
.all:hover { border-color: var(--ink); }
${CHIP_STYLE}
#how { background: var(--ground); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.steps { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 20px; }
.steps li { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
.steps .n { align-self: flex-start; background: var(--green); border-radius: 10px; padding: 3px; }
.steps .n span { display: block; border: 2px solid #fff; border-radius: 7px; padding: 3px 12px 1px; color: #fff; font-size: 20px; font-weight: 700; }
.steps h3 { margin: 0; font-size: 21px; }
.steps p { margin: 0; color: var(--ink2); }
#app { background: #006348; color: #fff; }
#app > .wrap { padding-top: 48px; padding-bottom: 48px; display: flex; flex-wrap: wrap; align-items: center; gap: 28px 48px; }
#app .pitch { flex: 1 1 420px; display: flex; flex-direction: column; gap: 14px; }
#app h2 { margin: 0; font-size: 36px; }
#app p { margin: 0; font-size: 18px; color: #E3EFE9; max-width: 620px; }
#app ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 17px; }
#app li { display: flex; gap: 10px; align-items: baseline; }
#app li::before { content: ''; flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #F2B300; transform: translateY(-2px); }
#app .join { flex: 0 1 340px; display: flex; flex-direction: column; gap: 12px; }
#app .join p { font-size: 15px; }
#app .join p a { color: #fff; font-weight: 800; }
`;

/**
 * On Home, the year chips and the pins swap the map's panel in place instead of loading the page
 * again. This is the picture's way; once the moving map loads (home-map.ts) it takes over.
 */
const HOME_SCRIPT = `
document.addEventListener('click', async (e) => {
  const link = e.target.closest && e.target.closest('a[data-map]');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  // Once the moving map is up (home-map.ts), its script has the year chips.
  if (document.querySelector('#map-panel[data-live]')) return;
  e.preventDefault();
  try {
    const res = await fetch(link.href, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(String(res.status));
    const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('map-panel');
    const panel = document.getElementById('map-panel');
    if (!next || !panel) throw new Error('no panel');
    panel.replaceWith(next);
    history.replaceState(null, '', link.href);
    const again = document.querySelector('#map-panel [href="' + link.getAttribute('href') + '"]');
    if (again) again.focus({ preventScroll: true });
  } catch {
    location.href = link.href;
  }
});`;

/** The trail back up: every step a link but the page itself. */
const CRUMB_STYLE = `
.crumbs ol { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; font-size: 15px; color: var(--ink2); }
.crumbs li + li::before { content: '/'; margin: 0 10px; color: var(--soft); }
.crumbs a { font-weight: 800; }
`;

/** Who also found a way: "Also found by Jamie and Pat" (Jamie, 2026-11-11: "You found it too"). */
const AlsoFound: FC<{ by: { handle: string; name: string }[] }> = ({ by }) =>
  by.length === 0 ? null : (
    <span class="also">
      Also found by{' '}
      {by.map((p, i) => (
        <>
          {i > 0 && (i === by.length - 1 ? ' and ' : ', ')}
          <a href={`/players/${p.handle}`}>{p.name}</a>
        </>
      ))}
    </span>
  );

const Crumbs: FC<{ trail: { name: string; href?: string }[] }> = ({ trail }) => (
  <nav class="crumbs" aria-label="Breadcrumb">
    <ol>
      {trail.map((step) => (
        <li>{step.href ? <a href={step.href}>{step.name}</a> : <span aria-current="page">{step.name}</span>}</li>
      ))}
    </ol>
  </nav>
);

/** A count in words up to twelve, the way the design writes "Eight numbers". */
const COUNT_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve'
];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/** The town in a place label: its last two parts ("Bloomington, Minnesota"), or all of a short one. */
const townOf = (label: string): string => {
  const parts = label.split(',').map((p) => p.trim());
  return parts.length > 2 ? parts.slice(-2).join(', ') : label;
};

const SHARE_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
const LINK_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);
const FEED_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
  >
    <path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" />
    <circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const ARROW = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    width="22"
    height="22"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={d} />
  </svg>
);

/** The sign posted just before or after this one, or, at either end, where the line stops. */
const Turn: FC<{ sign: Summary | undefined; way: 'older' | 'newer' }> = ({ sign, way }) => {
  const label = way === 'older' ? 'Older' : 'Newer';
  if (!sign) {
    return (
      <div class={`turn end ${way}`}>
        <span class="words">
          <span class="k">{label}</span>
          <strong>{way === 'older' ? 'This is the first sign' : 'This is the newest sign'}</strong>
          <a href="/signs">See every sign</a>
        </span>
      </div>
    );
  }
  const shot = sign.photos[0] ? <img src={sign.photos[0].thumb_url} alt="" loading="lazy" /> : null;
  const words = (
    <span class="words">
      <span class="k">{label}</span>
      <strong>{sign.title}</strong>
      <span class="soft">
        <Facts items={[finderNames(sign), shortDay(sign.found_on)]} />
      </span>
    </span>
  );
  return way === 'older' ? (
    <a class="turn older" href={`/signs/${sign.slug}`}>
      {ARROW('M19 12H5M11 6l-6 6 6 6')}
      {shot}
      {words}
    </a>
  ) : (
    <a class="turn newer" href={`/signs/${sign.slug}`}>
      {words}
      {shot}
      {ARROW('M5 12h14M13 6l6 6-6 6')}
    </a>
  );
};

const SIGN_STYLE = `
.sign { background: var(--ground); }
.sign > .wrap { padding-top: 20px; padding-bottom: 56px; display: flex; flex-direction: column; gap: 40px; }
${CRUMB_STYLE}
.cols { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "photos" "side" "spot"; gap: 32px; }
@media (min-width: 900px) {
  .cols { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); grid-template-rows: auto 1fr; column-gap: 48px;
    grid-template-areas: "photos side" "spot side"; }
}
.photos { grid-area: photos; display: flex; flex-direction: column; gap: 20px; }
.photos img { width: 100%; height: auto; border-radius: 16px; display: block; background: var(--photo); }
.side { grid-area: side; display: flex; flex-direction: column; gap: 20px; }
.side h1 { margin: 0; font-size: clamp(34px, 4.6vw, 50px); line-height: 1.05; }
.by { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--ink2); }
.by .faces { display: flex; }
.by .faces .avatar + .avatar { margin-left: -10px; box-shadow: 0 0 0 2px var(--ground); }
.by a { font-weight: 800; color: var(--ink); }
.by .sep { margin: 0 2px 3px; }
.acts { display: flex; flex-wrap: wrap; gap: 10px; }
.act { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px;
  border: 1.5px solid var(--line2); background: var(--card); font: inherit; font-size: 15px; font-weight: 800; color: var(--ink); cursor: pointer; }
.act:hover { border-color: var(--ink); }
.act[hidden] { display: none; }
.acts .tinylytics_kudos { min-height: 44px; padding: 0 16px; background: var(--card); }
.first { display: flex; flex-direction: column; gap: 8px; }
.first .plate > span { padding: 20px 24px; font-size: clamp(30px, 3.4vw, 42px); }
.credit { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; font-size: 15px; color: var(--ink2); }
.credit a { font-weight: 800; }
.credit .count { margin-left: auto; padding-left: 12px; font-size: 14px; color: var(--soft); }
.caption { margin: 0; font-size: 18px; }
.unsolved { margin: 0; font-size: 18px; font-weight: 800; }
.also { display: block; font-size: 14px; color: var(--soft); }
.also a { font-weight: 800; color: var(--ink2); }
.ways { display: flex; flex-direction: column; gap: 4px; }
.ways h2 { margin: 0; font-size: 18px; }
.ways ul { margin: 0; padding: 0; list-style: none; }
.ways li { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; }
.ways li + li { border-top: 1px solid var(--rule); }
.ways .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ways .eq { font-size: 16px; font-weight: 800; }
.ways .eq svg { max-width: 100%; height: auto; vertical-align: middle; }
.ways .soft { font-size: 13px; }
.ways .soft a { color: var(--soft); }
.cta { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 24px; padding: 20px; border-radius: 16px; background: var(--tint);
  color: #18201C; }
.cta > div { flex: 1 1 200px; }
.cta strong { display: block; font-weight: 800; }
.cta p { margin: 2px 0 0; color: #3B4540; }
.another { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 20px; border-radius: 10px;
  background: var(--green); color: #fff; font-weight: 800; text-decoration: none; }
.another:hover { background: var(--green-dark); color: #fff; }
.cta .go { flex: 0 1 auto; display: flex; flex-direction: column; gap: 10px; }
.another.quiz { background: transparent; color: var(--green-dark); box-shadow: inset 0 0 0 2px var(--green); }
.another.quiz:hover { background: var(--green); color: #fff; }
.spot { grid-area: spot; align-self: start; display: flex; flex-direction: column; gap: 14px; padding: 18px; background: var(--card); border: 1px solid var(--line);
  border-radius: 16px; }
.spot .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.spot h2 { margin: 0; font-size: 18px; }
.spot .label { flex: 1 1 200px; font-size: 15px; color: var(--ink2); }
.spot .head a { font-size: 15px; font-weight: 800; }
.where { position: relative; display: block; height: 300px; border-radius: 12px; overflow: hidden; background: var(--ground); }
.where img { position: absolute; width: 1462px; height: 915px; max-width: none; display: block; }
.where .pin { left: 50%; top: 50%; }
.spot .note { margin: 0; font-size: 14px; color: var(--soft); }
.lede { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-bottom: 18px; }
.lede h2 { margin: 0; font-size: clamp(24px, 3vw, 30px); }
.lede p { margin: 0; color: var(--ink2); }
.nums { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.nums li { display: flex; flex-direction: column; gap: 2px; padding: 14px; background: var(--card); border: 1px solid var(--line);
  border-radius: 12px; }
.nums b { font-size: 28px; font-weight: 900; line-height: 1.15; }
.nums .from { font-size: 14px; color: var(--ink2); overflow-wrap: anywhere; }
.nums .why { font-size: 13px; color: var(--soft); }
.turns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; }
.turn { display: flex; align-items: center; gap: 14px; min-height: 96px; padding: 14px 18px; background: var(--card);
  border: 1px solid var(--line); border-radius: 14px; color: var(--ink); text-decoration: none; }
a.turn:hover { border-color: var(--green-ink); color: var(--ink); }
.turn > svg { flex: 0 0 auto; color: var(--green-ink); }
.turn img { flex: 0 0 auto; width: 64px; height: 64px; border-radius: 8px; object-fit: cover; background: var(--photo); }
.turn .words { display: flex; flex-direction: column; min-width: 0; }
.turn .k { font-size: 14px; color: var(--soft); }
.turn strong { font-size: 18px; line-height: 1.25; }
.turn .soft { font-size: 14px; }
.turn.newer { justify-content: flex-end; text-align: right; }
.turn.end { border-style: dashed; background: transparent; }
.turn.end a { font-size: 14px; font-weight: 800; }
.near { display: flex; flex-direction: column; gap: 16px; }
.near h2 { margin: 0; font-size: clamp(24px, 3vw, 30px); }
`;

const SIGN_SCRIPT = `
const copy = document.querySelector('.copy');
if (copy && navigator.clipboard) {
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copy.dataset.url);
      copy.querySelector('span').textContent = 'Link copied';
    } catch {}
  });
}
const share = document.querySelector('.share');
if (share && navigator.share) {
  share.hidden = false;
  share.addEventListener('click', () => navigator.share({ title: share.dataset.title, url: share.dataset.url }).catch(() => {}));
}`;

const PLAYER_STYLE = `
.player { background: var(--ground); }
${NOPIN_STYLE}
.player > .wrap { padding-top: 20px; padding-bottom: 56px; display: flex; flex-direction: column; gap: 40px; }
${CRUMB_STYLE}
.who-is { display: flex; flex-wrap: wrap; align-items: center; gap: 20px 40px; }
.who-is > .avatar { box-shadow: 0 0 0 4px var(--page), 0 0 0 5px var(--line); }
@media (max-width: 599px) { .who-is > .avatar { width: 96px !important; height: 96px !important; font-size: 40px !important; } }
.who-is .id { flex: 1 1 320px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.who-is h1 { margin: 0; font-size: clamp(40px, 6vw, 56px); line-height: 1; }
.who-is .bio { margin: 6px 0 0; font-size: 20px; color: var(--ink2); }
.who-is .since { margin: 0; color: var(--ink2); }
.stats { margin: 0; display: flex; gap: 40px; }
.stats div { display: flex; flex-direction: column; align-items: center; }
.stats dd { margin: 0; order: -1; font-size: 36px; font-weight: 900; line-height: 1.1; }
.stats dt { color: var(--ink2); }
.feed { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px; border-radius: 999px;
  border: 1.5px solid var(--line2); background: var(--card); color: var(--ink); font-weight: 800; text-decoration: none; }
.feed:hover { border-color: var(--ink); color: var(--ink); }
.feed svg { color: #D9661A; }
.lede { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 18px; }
.lede h2 { margin: 0; font-size: clamp(26px, 3.5vw, 32px); }
.lede p { margin: 0; color: var(--ink2); }
.lede .chips { margin-left: auto; }
${CHIP_STYLE}
${BADGE_STYLE}
.squares { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 24px 20px; }
@media (max-width: 599px) { .squares { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 12px; } }
.squares a { display: flex; flex-direction: column; gap: 2px; color: var(--ink); text-decoration: none; }
.squares .shot { position: relative; display: block; aspect-ratio: 1 / 1; margin-bottom: 8px; border-radius: 12px; overflow: hidden;
  background: var(--photo); }
.squares img { width: 100%; height: 100%; object-fit: cover; display: block; }
.squares .tag { position: absolute; left: 6px; right: 6px; bottom: 6px; background: #006348; border-radius: 8px; padding: 2px; }
.squares .tag span { display: block; border: 1.5px solid #fff; border-radius: 6px; padding: 4px 6px 2px; color: #fff; font-size: 13px;
  font-weight: 800; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.squares strong { font-size: 17px; line-height: 1.25; }
.quizzer { margin: 0; color: var(--ink2); }
.qtab { display: inline-block; background: #F2B300; color: #18201C !important; font-weight: 900; font-size: 11px; letter-spacing: .1em;
  padding: 3px 6px 1px; border-radius: 5px; border: 1.5px solid #18201C; line-height: 1.2; text-decoration: none;
  vertical-align: 2px; margin-left: 2px; white-space: nowrap; }
.found { margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--rule); }
.found li { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(0, 1.1fr); gap: 20px; align-items: center; padding: 16px 0;
  border-top: 1px solid var(--rule); }
.found .shot { display: block; width: 120px; height: 84px; border-radius: 10px; overflow: hidden; background: var(--photo); }
.found .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
.found .what { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.found .title { font-weight: 900; font-size: 18px; color: var(--ink); text-decoration: none; }
.found .soft { font-size: 14px; }
.found .how { font-size: 14px; font-weight: 700; color: var(--ink2); display: flex; align-items: center; gap: 8px; }
.found .pill { display: inline-flex; font-size: 12px; font-weight: 900; letter-spacing: .04em; padding: 4px 9px 2px; border-radius: 999px;
  background: #F2B300; color: #18201C; text-transform: uppercase; }
@media (max-width: 699px) { .found li { grid-template-columns: 88px minmax(0, 1fr); gap: 12px 14px; }
  .found .shot { width: 88px; height: 66px; } .found .plate { grid-column: 1 / -1; } }
.squares .soft { font-size: 14px; }
@media (max-width: 599px) { .squares .tag { left: 4px; right: 4px; bottom: 4px; } .squares .tag span { font-size: 11px; padding: 3px 4px 1px; } .squares strong { font-size: 15px; } .squares .soft { font-size: 13px; } }
`;

/**
 * The pages, mounted beside the API. Every page is public: CloudFront keeps it a day (Popular six
 * hours) and is cleared when a page changes; browsers keep it a minute.
 */
export function createSite({
  store,
  urls,
  heartCounts,
  quizOpen = QUIZ_OPEN
}: Pick<ApiOptions, 'store' | 'urls' | 'heartCounts' | 'quizOpen'>): Hono {
  const site = new Hono();
  const people = async (): Promise<People> => new Map((await store.allPlayers()).map((p) => [p.id, p]));
  /** Hearts by path for Popular; undefined without Tinylytics or when they can't be read. */
  const counts = async () => heartCounts?.counts();
  const summary = (everyone: People) => (s: Sign) => signSummary(urls, everyone, s);
  const coFindsOn = (shown: Sign[]) => Promise.all(shown.map((s) => store.listCoFinds(s.id)));

  site.use(async (c, next) => {
    await next();
    if (c.res.headers.get('Cache-Control')) return;
    const popular = sortOf(c.req.query('sort')) === 'popular';
    c.header('Cache-Control', c.res.status !== 200 ? 'no-store' : popular ? POPULAR_CACHE : PAGE_CACHE);
  });

  // The map's picture, the logo and the icon never change between releases; browsers keep them a day.
  const DAY = 'public, max-age=86400';
  const svg = (body: string) => (c: Context) =>
    c.body(body, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': DAY });
  site.get('/us-map.svg', svg(US_MAP_SVG));
  // The Highway icon, the identity's default, as the package draws it.
  site.get('/favicon.svg', svg(HIGHWAY_SVG));
  for (const [file, body] of Object.entries(BRAND_FILES)) site.get(brandUrl(file), svg(body));
  // Highway for mail apps that read BIMI: the roadsignmath.xyz zone's default._bimi record names
  // this address, so it stays put whatever version the package is.
  site.get('/brand/road-sign-math-bimi.svg', svg(BIMI_SVG));
  mountIcons(site);

  // For search engines: every page that answers 200. The API and the sign-in link's landing
  // are not pages to index.
  // The API's OpenAPI description is allowed: llms.txt and /data point agents at it.
  site.get('/robots.txt', (c) =>
    c.text(
      `User-agent: *\nAllow: /\nAllow: /api/v1/openapi.json\nDisallow: /api/\nDisallow: /signin\n\nSitemap: ${urls.site}/sitemap.xml\n`
    )
  );
  site.get('/sitemap.xml', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic);
    const [lists, coFinds] = await Promise.all([Promise.all(shown.map((s) => store.listWays(s.id))), coFindsOn(shown)]);
    const ways = new Map<string, Way[]>(shown.map((s, i) => [s.id, lists[i]]));
    // A sign changes when it is posted and when a way is added; that is its lastmod.
    const changed = (s: Sign) => [s.postedAt, ...(ways.get(s.id) ?? []).map((w) => w.createdAt)].sort().at(-1)!;
    const entries: [string, string | undefined][] = [
      [`${urls.site}/`, shown.map(changed).sort().at(-1)],
      [`${urls.site}/signs`, shown.map(changed).sort().at(-1)],
      [`${urls.site}/players`, undefined],
      [`${urls.site}/app`, undefined],
      [`${urls.site}/about`, undefined],
      [`${urls.site}/privacy`, undefined],
      [`${urls.site}/rules`, undefined],
      [`${urls.site}/support`, undefined],
      [`${urls.site}/data`, undefined],
      ...shown.map((s): [string, string] => [`${urls.site}/signs/${s.slug}`, changed(s)]),
      // The same test as the player's page: a name, and a sign, a badge or a way found.
      ...[...everyone.values()]
        .filter(
          (p) =>
            p.name &&
            (playerStats(p, shown).sign_count ||
              earnedBadges(p.id, shown, ways).length ||
              waysFound(p, shown, lists, coFinds).length)
        )
        .map((p): [string, undefined] => [`${urls.site}/players/${p.handle}`, undefined])
    ];
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      entries
        .map(
          ([loc, lastmod]) =>
            `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>\n`
        )
        .join('') +
      '</urlset>\n';
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });

  // About: where the game came from, in Jamie's own words from his posts (thingelstad.com, 2023 and
  // 2026) and Things I've built. Text drafted for Jamie.
  site.get('/about', async (c) => {
    // The I-94 sign itself, photographed again in 2023, when it is on the site.
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const found = signs.find((s) => s.slug === 'genesis' && isPublic(s));
    const genesis = found ? summary(everyone)(found) : undefined;
    return c.html(
      <Page
        title="About · Road Sign Math"
        description="Road Sign Math is a road trip game Jamie Thingelstad started in 2005 with a sign on I-94: 3 × 33 = 99. Twenty years later it's an iPhone app."
        url={`${urls.site}/about`}
        here="about"
        style={ABOUT_STYLE}
      >
        <main id="main" class="wrap about">
          <h1>About</h1>
          <p class="lead">
            Road Sign Math is a road trip game. Find a road sign whose numbers make a true equation, take its picture,
            and write the math. Driving + Math = Fun.
          </p>

          <h2>The first sign</h2>
          <div class="first">
            {genesis?.photos[0] ? (
              <a class="shot" href={`/signs/${genesis.slug}`}>
                <img
                  src={genesis.photos[0].url}
                  alt={genesis.photos[0].alt ?? 'Photo of the I-94 sign'}
                  loading="lazy"
                />
                <Plate way={{ text: '3 × 33 = 99', tex: '3 \\times 33 = 99' }} />
              </a>
            ) : (
              <Plate way={{ text: '3 × 33 = 99', tex: '3 \\times 33 = 99' }} />
            )}
            <p>
              Driving I-94 East toward the Twin Cities, coming home from visiting family in North Dakota, I used to pass
              a sign that always made me smile: Melrose 3, St. Cloud 33, Minneapolis 99. Three times 33 is 99. I kept
              wondering how many other signs like it were out there. My friend Jim told me I should make a website, and
              so that day I did.
              {genesis && (
                <>
                  {' '}
                  In 2023 I <a href={`/signs/${genesis.slug}`}>photographed it again</a>.
                </>
              )}
            </p>
          </div>

          <h2>Three times around</h2>
          <ol class="eras">
            <li>
              <span class="when mono">2005–2016</span>
              <h3>roadsignmath.com</h3>
              <p>
                It started on February 13, 2005, as a blog of my signs, and soon other people were sending in theirs.
                Forty people sent 251 signs, from across the country and beyond, one from the Serengeti. With that many
                players it grew rules, a scoring system and scoreboards, and in 2011 it became a wiki so players could
                keep their own signs. I shut it down in 2016, when I let a number of projects go. The ones with a photo
                and math today’s game can check are back on the map, dated the day they were found, and all 251 are in{' '}
                <a href={ARCHIVE_URL}>the archive</a>.
              </p>
            </li>
            <li>
              <span class="when mono">2021–2025</span>
              <h3>A simple blog</h3>
              <p>
                A sign Tammy found near Phoenix in March 2021 gave the game a breath of new life as a plain blog, and
                that summer we found ten more on a road trip through Vermont. In 2023 the blog moved to
                roadsignmath.xyz: just my family’s signs, no scoring system or leaderboards. Sixteen signs, from Tammy,
                Tyler and me. <a href={`${THINGS_URL}road-sign-math-2021/`}>More about the blog</a>.
              </p>
            </li>
            <li>
              <span class="when mono">2026</span>
              <h3>The app</h3>
              <p>
                No version of Road Sign Math ever reached the dream I had for it in 2005, two years before the iPhone:
                that you could play it on your phone. The very essence of Road Sign Math is mobile. It’s something you
                do out in the world. With the help of Claude, that dream is real now. The iPhone app is the whole game:
                snap a sign, check the numbers it read, write the math, and post it. This website is the window for
                everyone else, with every sign on a map and no app or sign-in needed. The blog’s sixteen signs were the
                first ones in it. <a href={`${THINGS_URL}road-sign-math-2026/`}>How it was built</a>.
              </p>
            </li>
          </ol>

          <h2>No points</h2>
          <p>
            The first Road Sign Math had rules, scores and scoreboards. This one doesn’t. There are badges, little road
            signs for your first sign, new states, every season, each year you find a sign and a few secrets, but no
            scores and nothing to rank. The fun is in the finding, and anyone can find another way to make a sign work.
          </p>

          <h2>Follow along</h2>
          <p>
            Every new sign is posted to{' '}
            {FOLLOW.map((f, i) => (
              <>
                {i > 0 && ' and '}
                {f.name} as{' '}
                <a href={f.url} rel="me">
                  {f.handle}
                </a>
              </>
            ))}
            . The site has its own <a href="/data">feeds</a> too.
          </p>

          <h2>Who makes it</h2>
          <p>
            I’m <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>, and I build Road Sign Math with Claude,
            Anthropic’s AI. The <a href="https://github.com/jthingelstad/roadsignmath.xyz">website</a> and the{' '}
            <a href="https://github.com/jthingelstad/roadsignmath-ios">iPhone app</a> are open source. Read{' '}
            <a href="https://www.thingelstad.com/2026/10/31/road-sign-math-the-dream.html">
              Road Sign Math: The Dream Realized!
            </a>{' '}
            for the story of this one, and{' '}
            <a href={APP_STORE_URL} data-tinylytics-event="app.store" data-tinylytics-event-value="about">
              get the iPhone app
            </a>{' '}
            to play along. Questions are welcome at <a href="mailto:jamie@thingelstad.com">jamie@thingelstad.com</a>.
          </p>
        </main>
      </Page>
    );
  });

  // Privacy: what the game keeps and who sees it, in plain words. Text drafted for Jamie.
  site.get('/privacy', (c) =>
    c.html(
      <Page
        title="Privacy · Road Sign Math"
        description="What Road Sign Math keeps, what is public, and how to delete your account."
      >
        <main id="main" class="wrap" style="padding-top: 32px; padding-bottom: 48px; max-width: 720px">
          <h1>Privacy</h1>
          <p>
            Road Sign Math is a small road trip game Jamie Thingelstad runs for fun. This is what it keeps and who sees
            it.
          </p>
          <h2>What’s public</h2>
          <p>
            What you post is public, in the app and on this website: your signs’ photos, where each sign was found, the
            math, your caption, the ways you find on any sign, your name, your profile photo and your badges.
          </p>
          <p>
            It is shared under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, so anyone may use
            it, photos included, as long as they credit you and Road Sign Math. The <a href="/data">open data</a> says
            how.
          </p>
          <p>
            Every photo is saved again without its hidden details (camera, time and location) before anyone sees it. A
            sign’s place is shown on its map on purpose; a profile photo’s never is.
          </p>
          <h2>What stays private</h2>
          <p>
            Your email address. It is used to send you sign-in codes and the occasional Road Sign Math newsletter, which
            every player gets; each one has a link to unsubscribe. It is never shown or shared with other players.
          </p>
          <h2>Who helps run it</h2>
          <ul>
            <li>Claude, Anthropic’s AI, looks at each photo and post before it goes up.</li>
            <li>
              Amazon Web Services hosts this website, the app’s server and the photos, and sends the sign-in emails.
            </li>
            <li>
              Tinylytics counts visits to this website and to Quiz and screens viewed in the app, and keeps the hearts.
              It uses no cookies.
            </li>
            <li>
              Buttondown sends the newsletter. The game gives it your email address and a note of whether you play in
              the app, in Quiz or both (and, for the players from 2005 to 2014, that you played then), and nothing else.
            </li>
            <li>OpenStreetMap draws the map on the home page: your browser fetches the map’s tiles from it.</li>
          </ul>
          <h2>Quiz</h2>
          <p>
            <a href="https://quiz.roadsignmath.xyz">Quiz</a> is the game in your web browser: you find the math in signs
            other players posted. It uses the same account as the app, signed in with the same email. To keep you signed
            in it sets one cookie, which holds your sign-in and nothing else, and goes when you sign out. The ways you
            find there are public like any others, and Delete my account, in the app or on your profile in Quiz, removes
            them too. Tinylytics counts Quiz’s pages apart from this website’s.
          </p>
          <h2>Reports</h2>
          <p>
            When you report a sign, Claude looks at it again, and Jamie gets an email about it: the sign, your reason,
            what Claude decided and your player name. Your email address is never in it.
          </p>
          <h2>Leaving</h2>
          <p>
            Delete my account, in the app’s settings or on your profile in Quiz, deletes your account and everything you
            made: your signs and their photos, the ways you added, your hearts, your profile photo and your email
            address, which leaves the newsletter too.
          </p>
          <p>
            Road Sign Math keeps backup copies so a mistake can be undone. Anything deleted is gone from them within a
            year.
          </p>
          <h2>Questions</h2>
          <p>
            Email Jamie at <a href="mailto:jamie@thingelstad.com">jamie@thingelstad.com</a>. The{' '}
            <a href="/rules">house rules</a> say what can be posted.
          </p>
          <p class="soft">Updated 12 November 2026.</p>
        </main>
      </Page>
    )
  );

  // House rules: what can be posted, in Jamie's words (approved 2026-11-10). Sign-in in the app
  // says that signing in agrees to them.
  site.get('/rules', (c) =>
    c.html(
      <Page
        title="House rules · Road Sign Math"
        description="Road Sign Math is a free game Jamie Thingelstad makes for fun. Play nice."
        url={`${urls.site}/rules`}
      >
        <main id="main" class="wrap" style="padding-top: 32px; padding-bottom: 48px; max-width: 720px">
          <h1>House rules</h1>
          <p>Road Sign Math is a free game Jamie Thingelstad makes for fun. Play nice.</p>
          <ul>
            <li>Post road signs, with math that’s true.</li>
            <li>Nothing hateful, sexual, violent or cruel, and no photos that aren’t yours to share.</li>
            <li>
              Claude looks at every post. Anything that breaks these rules comes down, and so can the account that
              posted it.
            </li>
            <li>Never play while you drive. The passenger snaps the sign.</li>
            <li>It’s a hobby: free, as is, and no promise it’ll be here forever.</li>
          </ul>
          <p>
            Questions? Email Jamie at <a href="mailto:jamie@thingelstad.com">jamie@thingelstad.com</a>.
          </p>
        </main>
      </Page>
    )
  );

  // Help: who makes the game and how to reach him, for the App Store's support link. The paths
  // are the app's own (You, then the gear for Settings) and Quiz's (your profile, from the picture in
  // its header); Delete my account says what /privacy says.
  site.get('/support', (c) =>
    c.html(
      <Page
        title="Help · Road Sign Math"
        description="Road Sign Math is made by one person, Jamie Thingelstad, in spare time. How to reach him and how to delete your account."
        url={`${urls.site}/support`}
      >
        <main id="main" class="wrap" style="padding-top: 32px; padding-bottom: 48px; max-width: 720px">
          <h1>Help</h1>
          <p>Road Sign Math is made by one person, Jamie Thingelstad, in spare time.</p>
          <h2>Reach Jamie</h2>
          <p>
            In the app, tap your picture at the top of Home to open You, then the gear for Settings, and choose Send
            feedback under Help. Or email <a href="mailto:jamie@thingelstad.com">jamie@thingelstad.com</a>.
          </p>
          <h2>Delete your account</h2>
          <p>
            In the app, open You, then the gear for Settings, and choose Delete my account at the bottom. In Quiz,
            choose your picture at the top of any page to open your profile, then Delete my account at the bottom. It
            deletes your account and everything you made: your signs and their photos, the ways you added, your hearts,
            your profile photo and your email address, which leaves the newsletter too. It can’t be undone, and anything
            deleted is gone from the backups within a year.
          </p>
          <h2>More</h2>
          <ul>
            <li>
              <a href="/rules">House rules</a>: what can be posted.
            </li>
            <li>
              <a href="/privacy">Privacy</a>: what the game keeps and who sees it.
            </li>
            <li>
              <a href="/about">About</a>: where the game came from.
            </li>
          </ul>
        </main>
      </Page>
    )
  );

  // The sign-in link opens the app on an iPhone that has it (src/web/apple.ts). Anywhere else it
  // lands here, which says where to use it. The link's token never appears in the page, and the
  // page is never cached under it.
  site.get('/signin', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(
      <Page
        title="Sign in · Road Sign Math"
        description="Sign in to Road Sign Math in the iPhone app."
        count={false}
        banner={false}
      >
        <main id="main" class="wrap" style="padding-top: 32px; padding-bottom: 48px; max-width: 720px">
          <h1>Sign in on your iPhone</h1>
          <p>
            This link signs you in to the Road Sign Math app. Open it on the iPhone where the app is installed, or type
            the 6-digit code from the same email into the app.
          </p>
          <p>
            <a href="/">See the signs</a>
          </p>
        </main>
      </Page>
    );
  });

  site.get('/', async (c) => {
    // Home lists the latest signs; each sort is the Signs page's, so an old sorted Home link goes there.
    const asked = c.req.query('sort');
    if (asked && sortOf(asked) !== 'latest') return c.redirect(`/signs?sort=${sortOf(asked)}`, 301);
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic).sort(byNewest);
    const yearOf = (s: Sign) => s.foundOn.slice(0, 4);
    const years = [...new Set(shown.map(yearOf))].sort().reverse();
    const year = years.find((y) => y === c.req.query('year'));
    const seen = year ? shown.filter((s) => yearOf(s) === year) : shown;
    const { clusters } = cluster(seen);
    // Every year's, so the moving map can show another year's without asking again.
    const { unpinned } = cluster(shown);
    const at = c.req.query('at');
    const picked =
      clusters.find((k) => k.key === at) ?? clusters.find((k) => k.signs.some((s) => s.slug === at)) ?? clusters[0];
    const link = (params: { year?: string; at?: string }) => {
      const q = new URLSearchParams();
      if (params.year) q.set('year', params.year);
      if (params.at) q.set('at', params.at);
      const query = q.toString();
      return `/${query ? `?${query}` : ''}#map`;
    };
    const players = [...everyone.values()]
      .filter((p) => p.name)
      .map((p) => ({ player: p, count: playerStats(p, shown).sign_count }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count || a.player.name.localeCompare(b.player.name));
    const states = new Set(shown.map((s) => s.place.state).filter(Boolean));
    const card = summary(everyone);
    // The share card shows every pin, whatever year the page is filtered to.
    const pins = cluster(shown).clusters.map((k): [number, number, number] => [k.x, k.y, k.signs.length]);
    return c.html(
      <Page
        title="Road Sign Math"
        description="A road trip game: find a road sign whose numbers make a true equation. Every sign players have found, on a map."
        url={`${urls.site}/`}
        card={homeCard({ signCount: shown.length, playerCount: players.length, stateCount: states.size, pins })}
        here="map"
        style={HOME_STYLE + HOME_MAP_STYLE}
        script={HOME_SCRIPT + HOME_MAP_SCRIPT}
      >
        <main id="main">
          <section id="map" class="hero h-feed" aria-labelledby="hero-h">
            <data hidden class="p-name" value="Road Sign Math" />
            <data hidden class="u-url" value={`${urls.site}/`} />
            <data hidden class="u-map" value={`${urls.site}/us-map.svg`} />
            {pins.map((pin) => (
              <data hidden class="p-pin" value={pinValue(pin)} />
            ))}
            <div class="wrap">
              <div class="intro">
                <p class="kicker mono p-kicker">A road trip game</p>
                <h1 id="hero-h" class="p-summary">
                  Find a sign. Make the math true.
                </h1>
                <p>
                  Spot a road sign with numbers on it, then use those numbers to write something true. These are the
                  signs players have found, around the world. Tap a pin to see them.
                </p>
                <dl class="stats">
                  <div>
                    <dt>{shown.length === 1 ? 'sign' : 'signs'}</dt>
                    <dd class="mono p-sign-count">{shown.length}</dd>
                  </div>
                  <div>
                    <dt>{players.length === 1 ? 'player' : 'players'}</dt>
                    <dd class="mono p-player-count">{players.length}</dd>
                  </div>
                  <div>
                    <dt>{states.size === 1 ? 'state' : 'states'}</dt>
                    <dd class="mono p-state-count">{states.size}</dd>
                  </div>
                </dl>
              </div>
              <div id="map-panel">
                {years.length > 1 && (
                  <div class="years" role="group" aria-label="When it was found">
                    <a href={link({})} aria-current={year ? undefined : 'true'} data-map="">
                      All {shown.length}
                    </a>
                    {years.map((y) => (
                      <a href={link({ year: y })} aria-current={y === year ? 'true' : undefined} data-map="">
                        <Facts items={[y, String(shown.filter((s) => yearOf(s) === y).length)]} />
                      </a>
                    ))}
                  </div>
                )}
                <div class="map">
                  <img src="/us-map.svg" alt="Map of the United States with a pin for each place a sign was found" />
                  <Pins clusters={clusters} href={(k) => link({ year, at: k.key })} on={picked?.key} />
                </div>
                <section class="picked" aria-live="polite" aria-labelledby="picked-h">
                  <h2 id="picked-h">
                    {picked ? (
                      <Facts items={[clusterName(picked), countSigns(picked.signs.length)]} />
                    ) : (
                      'No signs on the map yet'
                    )}
                  </h2>
                  {picked && (
                    <ul>
                      {picked.signs.map(card).map((s) => (
                        <li>
                          <a href={`/signs/${s.slug}`}>
                            {s.photos[0] && <img src={s.photos[0].thumb_url} alt="" loading="lazy" />}
                            <span class="words">
                              <strong>{s.title}</strong>
                              <Eq sign={s} />
                              <span class="soft">
                                <Facts items={[finderNames(s), shortDay(s.found_on)]} />
                              </span>
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <NoPin signs={unpinned} byYear year={year} />
              </div>
              {/* After the map in the page so a phone, and a screen reader, reach the map first. */}
              {players.length > 0 && (
                <section class="who" aria-labelledby="who-h">
                  <h2 id="who-h">Who’s playing</h2>
                  <ul>
                    {players.slice(0, HOME_PLAYERS).map(({ player, count }) => (
                      <li>
                        <a href={`/players/${player.handle}`}>
                          <Avatar name={player.name} color={player.avatarColor} photo={player.avatar} />
                          <b>{player.name}</b>
                          <span class="soft">{countSigns(count)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  {players.length > HOME_PLAYERS && (
                    <a class="everyone" href="/players">
                      All {players.length} players
                    </a>
                  )}
                </section>
              )}
            </div>
          </section>

          <section id="signs" class="band" aria-labelledby="signs-h">
            <div class="wrap">
              <div class="lede">
                <h2 id="signs-h">Signs</h2>
                {/* Each sort opens on the Signs page, which has room for every sign. */}
                <SortChips on="latest" href={(key) => (key === 'latest' ? '/signs' : `/signs?sort=${key}`)} />
              </div>
              <div class="sortline">
                <p class="sortnote">{SORT_NOTES.latest} Every sign posted from the app shows up here.</p>
              </div>
              <ul class="tiles">
                {shown.slice(0, HOME_SIGNS).map((s) => (
                  <Tile sign={card(s)} place />
                ))}
              </ul>
              {shown.length > HOME_SIGNS && (
                <a class="all" href="/signs">
                  All {shown.length} signs
                </a>
              )}
            </div>
          </section>

          <section id="how" class="band" aria-labelledby="how-h">
            <div class="wrap">
              <h2 id="how-h">How to play</h2>
              <ol class="steps">
                <li>
                  <span class="n" aria-hidden="true">
                    <span class="mono">1</span>
                  </span>
                  <h3>Spot a sign</h3>
                  <p>
                    Any sign with numbers: exits, miles, speed limits, route numbers. The passenger takes the photo.
                  </p>
                </li>
                <li>
                  <span class="n" aria-hidden="true">
                    <span class="mono">2</span>
                  </span>
                  <h3>Make it true</h3>
                  <p>
                    Use the numbers with any math you like. It just has to be true. 12 + 1 = 13 is as good as a square
                    root.
                  </p>
                </li>
                <li>
                  <span class="n" aria-hidden="true">
                    <span class="mono">3</span>
                  </span>
                  <h3>Put it on the map</h3>
                  <p>
                    Your sign shows up here and in the app. Anyone who sees it can find another way to make it work.
                  </p>
                </li>
              </ol>
              <p style="margin: 0; color: var(--ink2)">There are no points. The fun is in the finding.</p>
            </div>
          </section>

          <section id="app" aria-labelledby="app-h">
            <div class="wrap">
              <div class="pitch">
                <h2 id="app-h">The game lives in the app</h2>
                <p>
                  Everything on this site is in the iPhone app, plus the camera. Point it at a sign, check the numbers
                  it reads, write your math, and post it to the map. Sign in with your email. There’s no password.
                </p>
                <ul>
                  <li>Passenger mode: the camera boxes every number it can read.</li>
                  <li>A math keypad with square roots and stacked fractions, and a live “It works”.</li>
                  <li>Badges for the road: your first sign, new states, mile markers, and a few secrets.</li>
                </ul>
              </div>
              <div class="join">
                <AppStoreBadge from="home" />
                <p>
                  Free for iPhone. Want new versions before everyone else? <BetaLink from="home" /> through Apple’s
                  TestFlight.
                </p>
                <a href="/app" style="color: #fff; font-weight: 800">
                  More about the app
                </a>
              </div>
            </div>
          </section>
        </main>
      </Page>
    );
  });

  mountSigns(site, { store, urls, people, counts });
  mountPlayers(site, { store, urls, people });
  mountAppPage(site, { urls });

  site.get('/signs/:slug', async (c) => {
    const signs = (await store.allSigns()).filter(isPublic);
    const found = signs.find((s) => s.slug === c.req.param('slug'));
    if (!found) return c.notFound();
    const [ways, coFinds, everyone] = await Promise.all([
      store.listWays(found.id),
      store.listCoFinds(found.id),
      people()
    ]);
    const sign = signDetail(urls, everyone, found, ways, undefined, coFinds);
    const byHandle = new Map([...everyone.values()].map((p) => [p.handle, p]));
    /** A finder's or a way's player's face: their colour, and their profile photo when they set one. */
    const faceOf = (handle: string | null | undefined) => {
      const player = handle ? byHandle.get(handle) : undefined;
      return { color: player?.avatarColor, photo: player?.avatar };
    };
    const description = `${sign.title}, ${sign.place.label}${sign.first_way ? `: ${sign.first_way.text}` : ''}`;
    // While Quiz is open, a sign with numbers to use can be tried there (Jamie, 2026-11-12).
    const tryInQuiz = quizOpen && urls.quiz && found.numbers.length ? `${urls.quiz}/signs/${found.slug}` : undefined;
    const { lat, lng } = found.place;
    const spot = lat !== undefined && lng !== undefined ? project(lat, lng) : null;
    const nearby =
      lat !== undefined && lng !== undefined
        ? signs
            .filter((s) => s.id !== found.id && s.place.lat !== undefined && s.place.lng !== undefined)
            .map((s) => ({ s, d: miles(lat, lng, s.place.lat!, s.place.lng!) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 4)
        : [];
    const card = summary(everyone);
    const finders = sign.finders.map((f) => f.name);
    const numbers = sign.numbers.map((n) => n.value);
    const share = signCard({
      path: `/signs/${sign.slug}`,
      title: sign.title,
      photo: sign.photos[0]?.url ?? null,
      place: sign.place.label,
      foundOn: sign.found_on,
      finders,
      way: sign.first_way && { text: sign.first_way.text, tex: sign.first_way.tex },
      wayCount: sign.ways.length,
      numbers
    });
    // Older and newer, in the order the signs were posted (the Latest sort).
    const order = [...signs].sort(byNewest);
    const at = order.findIndex((s) => s.id === found.id);
    const [newer, older] = [order[at - 1], order[at + 1]].map((s) => s && card(s));
    const [firstWay, ...moreWays] = sign.ways;
    const state = sign.place.state && STATES[sign.place.state];
    // Where a number was read, only when some number was read from more than itself.
    const from = (n: { value: string; text: string | null }) => (n.text && n.text !== n.value ? n.text : null);
    const read = sign.numbers.some((n) => from(n) || n.why);
    return c.html(
      <Page
        title={`${sign.title} · Road Sign Math`}
        description={description}
        url={sign.url}
        card={share}
        here="signs"
        style={SIGN_STYLE}
        script={SIGN_SCRIPT}
      >
        <main id="main" class="sign h-entry">
          <data hidden class="u-url" value={sign.url} />
          {sign.photos[0] && <data hidden class="u-photo" value={sign.photos[0].url} />}
          <data hidden class="p-location" value={sign.place.label} />
          {finders.map((name) => (
            <data hidden class="p-finder" value={name} />
          ))}
          {sign.first_way && <data hidden class="p-math" value={sign.first_way.text} />}
          {sign.first_way?.tex && <data hidden class="p-tex" value={sign.first_way.tex} />}
          <data hidden class="p-way-count" value={String(sign.ways.length)} />
          {numbers.map((n) => (
            <data hidden class="p-number" value={n} />
          ))}
          <div class="wrap">
            <Crumbs
              trail={[
                { name: 'All signs', href: '/signs' },
                ...(state ? [{ name: state, href: `/signs?state=${sign.place.state}` }] : []),
                { name: sign.title }
              ]}
            />
            <div class="cols">
              <div class="photos">
                {sign.photos.map((p) => (
                  <img src={p.url} alt={p.alt} width={p.width} height={p.height} />
                ))}
              </div>
              <div class="side">
                <h1 class="p-name">{sign.title}</h1>
                <p class="by">
                  <span class="faces">
                    {sign.finders.map((f) => (
                      <Avatar name={f.name} {...faceOf(f.handle)} size={32} />
                    ))}
                  </span>
                  <span>
                    <Finders sign={sign} /> found it on{' '}
                    <time class="dt-published" datetime={sign.found_on}>
                      {shortDay(sign.found_on)}
                    </time>
                  </span>
                  <Sep />
                  <span>{townOf(sign.place.label)}</span>
                </p>
                <div class="acts">
                  <Heart sign={sign} />
                  <button type="button" class="act share" data-url={sign.url} data-title={sign.title} hidden>
                    {SHARE_ICON}
                    <span>Share</span>
                  </button>
                  <button type="button" class="act copy" data-url={sign.url} hidden>
                    {LINK_ICON}
                    <span>Copy link</span>
                  </button>
                </div>
                {firstWay ? (
                  <div class="first">
                    <Plate way={firstWay} />
                    <p class="credit">
                      {firstWay.by && (
                        <>
                          <a href={`/players/${firstWay.by.handle}`}>{firstWay.by.name || firstWay.by.handle}</a>
                          <Sep />
                        </>
                      )}
                      <span>both sides are {firstWay.value}</span>
                      <span class="count">
                        {sign.ways.length} {sign.ways.length === 1 ? 'way' : 'ways'} so far
                      </span>
                    </p>
                    <AlsoFound by={firstWay.also_found_by} />
                  </div>
                ) : (
                  <p class="unsolved">Nobody has solved it yet.</p>
                )}
                {sign.caption && <p class="caption">{sign.caption}</p>}
                {moreWays.length > 0 && (
                  <section class="ways" aria-labelledby="ways-h">
                    <h2 id="ways-h">More ways</h2>
                    <ul>
                      {moreWays.map((w) => (
                        <li>
                          <Avatar name={w.by?.name || w.by?.handle || '?'} {...faceOf(w.by?.handle)} size={32} />
                          <span class="what">
                            {w.tex === null ? (
                              <span class="eq">{w.text}</span>
                            ) : (
                              <span
                                class="eq"
                                role="img"
                                aria-label={w.text}
                                dangerouslySetInnerHTML={{ __html: mathSvg(w.tex) }}
                              />
                            )}
                            <span class="soft">
                              {w.by && (
                                <>
                                  <a href={`/players/${w.by.handle}`}>{w.by.name || w.by.handle}</a>
                                  <Sep />
                                </>
                              )}
                              both sides are {w.value}
                            </span>
                            <AlsoFound by={w.also_found_by} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <div class="cta">
                  <div>
                    <strong>{firstWay ? 'See another way to make it true?' : 'Can you make it true?'}</strong>
                    <p>
                      {tryInQuiz
                        ? 'Add a way in the app, or in your browser with Quiz. The keypad checks your math as you go.'
                        : 'Ways are added from the app, where the keypad checks your math as you go.'}
                    </p>
                  </div>
                  <div class="go">
                    <a class="another" href="/app" data-tinylytics-event="app.get" data-tinylytics-event-value="sign">
                      {firstWay ? 'Find another way in the app' : 'Solve it in the app'}{' '}
                      <span aria-hidden="true">→</span>
                    </a>
                    {tryInQuiz && (
                      <a
                        class="another quiz"
                        href={tryInQuiz}
                        data-tinylytics-event="quiz.try"
                        data-tinylytics-event-value="sign"
                      >
                        Try this one in Quiz <span aria-hidden="true">→</span>
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <section class="spot" aria-labelledby="where-h">
                <div class="head">
                  <h2 id="where-h">Where</h2>
                  <span class="label">{sign.place.label}</span>
                  {spot && <a href={`/?at=${sign.slug}#map`}>See it on the map</a>}
                </div>
                {spot && (
                  <a class="where" href={`/?at=${sign.slug}#map`} tabindex={-1} aria-hidden="true">
                    <img
                      src="/us-map.svg"
                      alt=""
                      style={`left: calc(50% - ${((spot.x / 100) * 1462).toFixed(1)}px); top: calc(50% - ${((spot.y / 100) * 915).toFixed(1)}px)`}
                    />
                    <span class="pin on" aria-hidden="true" />
                  </a>
                )}
                {(!spot || sign.place.approximate) && (
                  <p class="note">
                    {spot ? 'The pin is on the town, not the exact spot.' : 'There’s no pin on the map for this one.'}
                  </p>
                )}
              </section>
            </div>
            {sign.numbers.length > 0 && (
              <section aria-labelledby="nums-h">
                <div class="lede">
                  <h2 id="nums-h">The numbers on this sign</h2>
                  <p>
                    {countWord(sign.numbers.length)} {sign.numbers.length === 1 ? 'number' : 'numbers'}
                    {read && `, and where ${sign.numbers.length === 1 ? 'it was' : 'each one was'} read`}.
                  </p>
                </div>
                <ul class="nums" aria-label="Numbers on the sign">
                  {sign.numbers.map((n) => (
                    <li>
                      <b class="mono">{n.value}</b>
                      {from(n) && <span class="from">from {from(n)}</span>}
                      {n.why && <span class="why">{n.why}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {order.length > 1 && (
              <nav class="turns" aria-label="Older and newer signs">
                <Turn sign={older} way="older" />
                <Turn sign={newer} way="newer" />
              </nav>
            )}
            {nearby.length > 0 && (
              <section class="near" aria-labelledby="near-h">
                <h2 id="near-h">Nearby</h2>
                <ul class="tiles">
                  {nearby.map(({ s, d }) => (
                    <Tile sign={card(s)} distance={`${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} mi`} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </main>
      </Page>
    );
  });

  site.get('/players/:handle', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const player = [...everyone.values()].find((p) => p.handle === c.req.param('handle'));
    const shown = signs.filter(isPublic).sort(byNewest);
    if (!player?.name) return c.notFound();
    const stats = playerStats(player, shown);
    const lists = await Promise.all(shown.map((s) => store.listWays(s.id)));
    const ways = new Map<string, Way[]>(shown.map((s, i) => [s.id, lists[i]]));
    const badges = earnedBadges(player.id, shown, ways).map((e) => earnedBadgeView(urls, e));
    // A player with no signs of their own shows the ways they found on other players' signs:
    // their own, and the ones they found too (one row a sign, the most recent).
    const coFinds = stats.sign_count ? [] : await coFindsOn(shown);
    const solved = stats.sign_count ? [] : waysFound(player, shown, lists, coFinds);
    // A player with nothing on the map yet has no page.
    if (!stats.sign_count && !badges.length && !solved.length) return c.notFound();
    // Every way they found too counts, not only the one a sign that shows.
    const foundToo = coFinds.flat().filter((f) => f.playerId === player.id);
    const since = [playingSince(player, shown, ways), ...foundToo.map((f) => centralDay(f.createdAt))]
      .filter((d): d is string => !!d)
      .sort()[0];
    const view = c.req.query('view') === 'map' ? 'map' : 'signs';
    return c.html(
      <PlayerPage
        urls={urls}
        player={player}
        everyone={everyone}
        stats={stats}
        badges={badges}
        since={since ?? null}
        view={view}
        summary={summary(everyone)}
        solved={solved}
        quiz={quizOpen ? urls.quiz : undefined}
      />
    );
  });

  // The feeds, the open data files, llms.txt and the /data page that documents them.
  site.route('/', createOpenWeb({ store, urls }));
  // The micro.blog's old addresses, last so no page here is ever shadowed by one.
  site.route('/', createOldLinks({ store, urls }));

  return site;
}

type Found = { sign: Sign; solve: Solve };

// A way found later is dated by its day in US Central, the game's home, as its badges are.
const CENTRAL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
const centralDay = (at: string): string => CENTRAL_DAY.format(new Date(at));

/**
 * The signs a player solved without being credited on them (one row a sign: the way they found
 * there most recently, their own or one they found too), the most recent first. `lists` and
 * `coFinds` are each shown sign's, in the same order.
 */
function waysFound(player: Player, shown: Sign[], lists: Way[][], coFinds: CoFind[][]): Found[] {
  return shown
    .flatMap((sign, i) => {
      if (credits(sign, player.id)) return [];
      const solve = solveOf(sign, { ways: lists[i], coFinds: coFinds[i] }, player.id);
      return solve ? [{ sign, solve }] : [];
    })
    .sort((a, b) => b.solve.at.localeCompare(a.solve.at));
}

/** One way a player found on someone else's sign: the sign, how they found it, and the math. */
const FoundRow: FC<{ sign: Summary; solve: Solve; everyone: People }> = ({ sign, solve, everyone }) => {
  const day = shortDay(centralDay(solve.at));
  const owner = everyone.get(solve.way.playerId)?.name;
  return (
    <li>
      <a class="shot" href={`/signs/${sign.slug}`} tabindex={-1} aria-hidden="true">
        {sign.photos[0] && <img src={sign.photos[0].thumb_url} alt="" loading="lazy" />}
      </a>
      <div class="what">
        <a class="title" href={`/signs/${sign.slug}`}>
          {sign.title}
        </a>
        <span class="soft">
          <Facts items={[`Found by ${finderNames(sign)}`, sign.place.label]} />
        </span>
        <span class="how">
          {solve.kind === 'first' ? (
            <>
              <span class="pill">First way</span> {day}
            </>
          ) : solve.kind === 'too' ? (
            <Facts items={[owner ? `Also found ${owner}’s way` : 'Also found a way already there', day]} />
          ) : (
            <Facts items={['A new way', day]} />
          )}
        </span>
      </div>
      <Plate way={{ text: solve.way.text, tex: texOf(solve.way.text) ?? null }} />
    </li>
  );
};

const PlayerPage: FC<{
  urls: Urls;
  player: Player;
  everyone: People;
  stats: ReturnType<typeof playerStats>;
  badges: ReturnType<typeof earnedBadgeView>[];
  since: string | null;
  view: 'signs' | 'map';
  summary: (s: Sign) => Summary;
  solved: Found[];
  /** Quiz's address, while Quiz is open. */
  quiz?: string;
}> = ({ urls, player, everyone, stats, badges, since, view, summary, solved, quiz }) => {
  const { clusters, unpinned } = cluster(stats.signs);
  // The years are their own row, above the rest (Jamie, 2026-11-07).
  const years = badges.filter((b) => b.shelf === 'years');
  const others = badges.filter((b) => b.shelf !== 'years');
  const base = `/players/${player.handle}`;
  const photo = player.avatar ? photoUrl(urls, player.avatar, 'large') : null;
  const found = stats.first_year ? ` since ${stats.first_year}` : '';
  return (
    <Page
      title={`${player.name} · Road Sign Math`}
      description={`Road signs ${player.name} found${found}.`}
      url={`${urls.site}${base}`}
      card={playerCard({
        path: base,
        name: player.name,
        photo,
        color: player.avatarColor,
        signCount: stats.sign_count,
        stateCount: stats.states.length,
        firstYear: stats.first_year
      })}
      // Their feeds are of their signs, and answer once they have a sign or a badge (src/web/data.ts).
      feeds={
        stats.sign_count || badges.length
          ? feedAlternates({ title: `${player.name} · Road Sign Math`, base: `${urls.site}${base}` }, urls.site)
          : undefined
      }
      here="players"
      style={PLAYER_STYLE}
    >
      <main id="main" class="player">
        <div class="wrap">
          <Crumbs trail={[{ name: 'All players', href: '/players' }, { name: player.name }]} />
          <div class="who-is h-card">
            <data hidden class="u-url" value={`${urls.site}${base}`} />
            {photo && <data hidden class="u-photo" value={photo} />}
            <data hidden class="p-avatar-color" value={player.avatarColor} />
            <data hidden class="p-sign-count" value={String(stats.sign_count)} />
            <data hidden class="p-state-count" value={String(stats.states.length)} />
            {stats.first_year && <data hidden class="p-first-year" value={String(stats.first_year)} />}
            <Avatar name={player.name} color={player.avatarColor} photo={player.avatar} size={136} />
            <div class="id">
              <h1 class="p-name">{player.name}</h1>
              {player.bio && <p class="bio p-note">{player.bio}</p>}
              {since && <p class="since">Playing since {since.slice(0, 4)}</p>}
              {quiz && solved.length > 0 && (
                <p class="quizzer">
                  Finds the math in other players’ signs with{' '}
                  <a class="qtab" href={`${quiz}/`}>
                    QUIZ
                  </a>
                </p>
              )}
            </div>
            {stats.sign_count > 0 && (
              <>
                <dl class="stats">
                  <div>
                    <dt>{stats.sign_count === 1 ? 'sign' : 'signs'}</dt>
                    <dd>{stats.sign_count}</dd>
                  </div>
                  <div>
                    <dt>{stats.states.length === 1 ? 'state' : 'states'}</dt>
                    <dd>{stats.states.length}</dd>
                  </div>
                </dl>
                <a class="feed" href={`${base}/feed.xml`} type="application/atom+xml">
                  {FEED_ICON}
                  Follow {player.name}’s signs (feed)
                </a>
              </>
            )}
          </div>
          {years.length > 0 && (
            <section aria-labelledby="years-h">
              <div class="lede">
                <h2 id="years-h">Years</h2>
                <p>A badge for every year {player.name} found a sign. They are not easy to find.</p>
              </div>
              <YearPlates badges={years} />
            </section>
          )}
          {others.length > 0 && (
            <section aria-labelledby="badges-h">
              <div class="lede">
                <h2 id="badges-h">Badges</h2>
                <p>Earned on the road. Some badges are secret until someone finds them.</p>
              </div>
              <BadgeCards badges={others} />
            </section>
          )}
          {solved.length > 0 && (
            <section aria-labelledby="ways-h">
              <div class="lede">
                <h2 id="ways-h">Ways found</h2>
                <p>On signs other players spotted. {player.name} hasn’t posted a sign of their own yet.</p>
              </div>
              <ul class="found" aria-label={`Ways ${player.name} found`}>
                {solved.map(({ sign, solve }) => (
                  <FoundRow sign={summary(sign)} solve={solve} everyone={everyone} />
                ))}
              </ul>
            </section>
          )}
          {stats.sign_count > 0 && (
            <section aria-labelledby="signs-h">
              <div class="lede">
                <h2 id="signs-h">{player.name}’s signs</h2>
                <nav class="chips" aria-label={`${player.name}’s signs as`}>
                  <a class="chip" href={base} aria-current={view === 'signs' ? 'page' : undefined}>
                    Signs
                    <Sep />
                    {stats.sign_count}
                  </a>
                  <a class="chip" href={`${base}?view=map`} aria-current={view === 'map' ? 'page' : undefined}>
                    Map
                  </a>
                </nav>
              </div>
              {view === 'signs' ? (
                <ul class="squares" aria-label={`${player.name}’s signs`}>
                  {stats.signs.map(summary).map((s) => (
                    <li>
                      <a href={`/signs/${s.slug}`}>
                        <span class="shot">
                          {s.photos[0] && <img src={s.photos[0].thumb_url} alt="" loading="lazy" />}
                          {s.first_way && (
                            <span class="tag">
                              <span>{s.first_way.text}</span>
                            </span>
                          )}
                        </span>
                        <strong>{s.title}</strong>
                        <span class="soft">
                          <Facts
                            items={[shortDay(s.found_on), (s.place.state && STATES[s.place.state]) || s.place.label]}
                          />
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style="display: flex; flex-direction: column; gap: 12px">
                  <div class="map">
                    <img src="/us-map.svg" alt={`Map of the United States with ${player.name}’s signs pinned`} />
                    <Pins
                      clusters={clusters}
                      href={(k) => (k.signs.length === 1 ? `/signs/${k.signs[0].slug}` : `/?at=${k.key}#map`)}
                    />
                  </div>
                  <NoPin signs={unpinned} />
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </Page>
  );
};
