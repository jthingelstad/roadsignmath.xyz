// Quiz's pages, as the Quiz design boards draw them: home, sign-in (email, code, name), a sign to
// solve, what sending found (a new way, the first way, a way found too), the ways on a sign, the
// signs you've solved, and the end when none are left. Server-drawn Hono JSX; the one script of
// its own is the solve page's keypad (src/quiz/keypad.ts). Nothing here counts or ranks: no
// points, scores, streaks, timers or totals.

import type { FC, PropsWithChildren } from 'hono/jsx';
import { texOf } from '../domain/equation.ts';
import type { Player, Sign, Way } from '../domain/types.ts';
import { LIMITS } from '../api/contract.ts';
import { BIO_MAX, NAME_MAX } from '../auth/account.ts';
import { photoUrl, playerUrl, signPath, signUrl, type People } from '../api/views.ts';
import { BRAND_VERSION, LOCKUP_SIZE } from '../web/brand.ts';
import { BADGE_STYLE, BadgeCards, type BadgeView } from '../web/badges.tsx';
import { longDay } from '../web/layout.tsx';
import { mathSvg } from '../web/math.ts';
import { QUIZ_TINYLYTICS_SITE, TINYLYTICS_SCRIPT } from '../web/tinylytics.ts';
import { CHECKER_JS } from './checker.ts';
import { KEYPAD_JS } from './keypad.ts';
import type { OnSign, Solve } from './data.ts';

/** Where Quiz's pages link and load from: its own origin, and the site's for photos and logos. */
export type Here = { site: string; quiz: string };

const STYLE = `
:root { color-scheme: light dark; --ink: #18201C; --ink2: #3B4540; --soft: #55605A; --line: #D8DED9; --line2: #B9C3BB;
  --rule: #E6EAE6; --page: #FFFFFF; --ground: #F3F5F2; --card: #FFFFFF; --photo: #DDE3DD; --green: #006348;
  --green-ink: #006348; --tint: #E3EFE9; --tint-ink: #1F3A2E; --warn: #FFF4CC; --warn-ink: #3A2E00; --bad: #8A1C2B; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #E8EFEB; --ink2: #C3CEC8; --soft: #9FB0A7; --line: #2C3A33; --line2: #3F5048; --rule: #24302A;
    --page: #101713; --ground: #151E19; --card: #18221D; --photo: #24302A; --green-ink: #5CC395; --tint: #183126;
    --tint-ink: #CFE3D8; --warn: #2E2608; --warn-ink: #F6E7B0; --bad: #F2A7B1; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.sep { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: currentColor; vertical-align: middle;
  margin: 0 6px 3px; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.45 Overpass, system-ui, -apple-system, sans-serif; }
a { color: var(--green-ink); }
.skip { position: absolute; left: -999px; top: 8px; background: var(--card); padding: 8px 12px; border-radius: 8px; }
.skip:focus { left: 8px; z-index: 10; }
.top { border-bottom: 1px solid var(--line); }
.top .wrap { display: flex; align-items: center; gap: 12px; padding-top: 10px; padding-bottom: 10px; }
.wrap { max-width: 1160px; margin: 0 auto; padding-left: 16px; padding-right: 16px; }
.brand { display: flex; align-items: center; gap: 8px; text-decoration: none; flex: 1; min-height: 44px; }
.brand img { height: 30px; width: auto; display: block; }
.qtab { display: inline-block; background: #F2B300; color: #18201C; font-weight: 900; font-size: 12px; letter-spacing: .1em;
  padding: 4px 7px 2px; border-radius: 5px; border: 1.5px solid #18201C; line-height: 1.2; }
.me { display: flex; align-items: center; gap: 10px; min-height: 44px; font-weight: 800; color: var(--ink); text-decoration: none; }
.me .label { display: none; }
.signin { min-height: 44px; display: flex; align-items: center; padding: 0 8px; font-weight: 800; text-decoration: none; }
.av { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff;
  font-weight: 900; padding-top: 2px; overflow: hidden; }
.av.ink { color: #18201C; }
.av.pic { padding: 0; background: var(--photo); }
.av img { width: 100%; height: 100%; object-fit: cover; display: block; }
main { padding-top: 16px; padding-bottom: 28px; }
.stack { display: flex; flex-direction: column; gap: 14px; }
.narrow { max-width: 560px; }
h1 { margin: 0; font-size: 26px; line-height: 1.12; font-weight: 900; letter-spacing: -.01em; }
.h2 { margin: 0; font-size: 19px; font-weight: 900; }
.meta { margin: 0; font-size: 14px; color: var(--soft); }
.lede { margin: 0; font-size: 17px; line-height: 1.45; color: var(--ink2); }
.photo { width: 100%; height: 220px; object-fit: cover; border-radius: 14px; display: block; background: var(--photo); }
.btn { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 52px; padding: 0 18px; border-radius: 14px;
  border: 0; background: var(--green); color: #fff; font: inherit; font-size: 17px; font-weight: 800; text-decoration: none;
  cursor: pointer; width: 100%; }
a.btn { color: #fff; }
.btn.ghost, a.btn.ghost { background: transparent; color: var(--ink); border: 1.5px solid var(--line2); }
.btn[disabled] { background: var(--line); color: var(--soft); cursor: default; }
.txt { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 6px; border: 0; background: transparent;
  font: inherit; font-size: 16px; font-weight: 800; color: var(--green-ink); cursor: pointer; text-decoration: none; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.plate { background: var(--green); border-radius: 16px; padding: 5px; }
.plate > div { border: 2.5px solid #fff; border-radius: 12px; color: #fff; font: 500 24px/1.2 'STIX Two Text', Georgia, serif;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px 8px; padding: 14px 10px; min-height: 72px;
  text-align: center; overflow-x: auto; }
.plate > div.empty { font: 800 17px Overpass, system-ui, sans-serif; color: #E3EFE9; }
.plate svg { max-width: 100%; height: auto; color: #fff; }
.plate.big > div { min-height: 96px; }
.plate.mini { border-radius: 10px; padding: 3px; display: inline-block; }
.plate.mini > div { border-width: 1.5px; border-radius: 8px; padding: 6px 10px; min-height: 0; font-size: 18px; }
.tabbed { display: flex; flex-direction: column; align-items: center; }
.tabbed > .plate { width: 100%; }
.tab { background: var(--green); border-radius: 9px 9px 0 0; padding: 4px 4px 0; margin-bottom: -2px; }
.tab > span { display: block; border: 2px solid #fff; border-bottom: 0; border-radius: 6px 6px 0 0; color: #fff; font-weight: 900;
  font-size: 12px; letter-spacing: .14em; padding: 6px 12px 4px; text-transform: uppercase; }
.tiles { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.tiles.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.nt { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 54px; padding: 4px;
  border-radius: 10px; border: 1.5px solid var(--green-ink); background: var(--card); color: var(--green-ink); font: inherit;
  cursor: pointer; width: 100%; }
.nt b { font: 700 20px/1.1 'Overpass Mono', ui-monospace, monospace; }
.nt small { font-size: 11px; font-weight: 700; color: var(--soft); max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.nt.used { border-color: var(--line); background: var(--ground); color: var(--soft); cursor: default; }
.keys { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 7px; }
.k { height: 46px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font: inherit;
  font-size: 20px; font-weight: 800; cursor: pointer; }
.k.del { grid-column: span 2; }
.chk { display: flex; gap: 10px; align-items: center; min-height: 46px; padding: 8px 14px; border-radius: 12px; font-size: 15px; }
.chk .said { flex: 1; }
.chk .aside { font-size: 13px; font-weight: 700; }
.chk.ok { background: var(--tint); color: var(--tint-ink); font-weight: 800; }
.chk.wait { background: var(--ground); color: var(--ink2); font-weight: 700; }
.field { width: 100%; min-height: 52px; padding: 12px 14px; border-radius: 12px; border: 1.5px solid var(--line2); background: var(--card);
  color: var(--ink); font: inherit; font-size: 18px; }
.field.code { font: 700 28px 'Overpass Mono', ui-monospace, monospace; letter-spacing: .3em; text-align: center; }
label { font-weight: 800; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 900; letter-spacing: .04em; padding: 4px 9px 2px;
  border-radius: 999px; background: var(--tint); color: var(--tint-ink); white-space: nowrap; text-transform: uppercase; }
.pill.y { background: #F2B300; color: #18201C; }
.pill.g { background: var(--ground); color: var(--ink2); }
.callout { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 14px; background: var(--warn); color: var(--warn-ink);
  border: 1.5px solid #F2B300; font-size: 15px; line-height: 1.45; }
.callout strong { font-size: 16px; }
.note { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 12px; background: var(--tint); color: var(--tint-ink);
  font-size: 15px; line-height: 1.45; }
.oops { padding: 12px 14px; border-radius: 12px; border: 1.5px solid var(--bad); color: var(--bad); font-weight: 700; }
.card { border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
.way { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-top: 1px solid var(--rule); }
.who { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink2); }
.who b { color: var(--ink); font-weight: 800; }
.solved { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.solved li { border-top: 1px solid var(--rule); }
.solved a { display: flex; gap: 12px; padding: 12px 0; text-decoration: none; color: var(--ink); }
.solved img { width: 76px; height: 76px; object-fit: cover; border-radius: 10px; background: var(--photo); flex: 0 0 auto; }
.solved .what { display: flex; flex-direction: column; gap: 6px; min-width: 0; align-items: flex-start; }
.solved strong { font-weight: 900; }
.steps { display: grid; gap: 12px; }
.step { display: flex; gap: 12px; align-items: flex-start; }
.step > span { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 8px; background: var(--green); color: #fff; font-weight: 900;
  display: flex; align-items: center; justify-content: center; padding-top: 2px; }
.step p { margin: 3px 0 0; }
.figs { display: grid; gap: 16px; }
.figs figure { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.figs img { width: 100%; height: 180px; object-fit: cover; border-radius: 14px; background: var(--photo); }
.end { background: var(--green); border-radius: 16px; padding: 6px; color: #fff; }
.end > div { border: 3px solid #fff; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; align-items: center;
  gap: 4px; font-weight: 900; letter-spacing: .06em; font-size: 22px; text-align: center; }
.foot { border-top: 1px solid var(--line); }
.foot .wrap { display: flex; flex-wrap: wrap; gap: 6px 18px; padding-top: 16px; padding-bottom: 16px; font-size: 14px; font-weight: 700; }
.solve { display: grid; gap: 14px; }
.btn.danger, a.btn.danger { background: transparent; color: var(--bad); border: 1.5px solid var(--bad); }
.txt.bad { color: var(--bad); }
.prof { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px 14px; text-align: center; }
.prof .name { font-size: 22px; font-weight: 900; }
.prof .bio { margin: 0; color: var(--ink2); max-width: 420px; }
.part { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--line); padding-top: 18px; }
.photo-row { display: flex; align-items: center; gap: 14px; }
.photo-row p { margin: 0; }
.field.file { font-size: 15px; padding: 12px; }
.facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; }
.facts dt { font-weight: 800; }
.facts dd { margin: 0; color: var(--ink2); overflow-wrap: anywhere; }
@media (min-width: 900px) {
  .brand img { height: 36px; }
  .me .label { display: inline; }
  h1 { font-size: 32px; }
  main { padding-top: 32px; }
  .photo { height: 420px; border-radius: 18px; }
  .solve { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 40px; align-items: start; }
  .solve > .work { position: sticky; top: 24px; }
  .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 64px; align-items: center; }
  .hero h1 { font-size: 52px; line-height: 1.04; }
  .figs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .steps { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;

/** Carries the sign a player came to try through signing in (`to`, an id or a slug Quiz checked). */
const BackTo: FC<{ to?: string }> = ({ to }) => (to ? <input type="hidden" name="to" value={to} /> : null);

/** Quiz's frame: header with the logo and the Quiz tab, the page, and a footer to the site. */
export const Frame: FC<
  PropsWithChildren<{
    here: Here;
    title: string;
    player?: Player;
    script?: string;
    description?: string;
    /** Adds Quiz's Tinylytics counter. The sign-in link's page leaves it out: its URL carries the token. */
    count?: boolean;
  }>
> = ({ here, title, player, script, description, count = true, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title === 'Road Sign Math Quiz' ? title : `${title} · Road Sign Math Quiz`}</title>
      <meta
        name="description"
        content={description ?? 'Find the math in road signs spotted on real road trips. Road Sign Math Quiz.'}
      />
      <meta name="theme-color" content="#006348" />
      <link rel="icon" href={`${here.site}/favicon.svg`} type="image/svg+xml" />
      <link rel="apple-touch-icon" href={`${here.site}/apple-touch-icon.png`} />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800;900&family=Overpass+Mono:wght@400;700&family=STIX+Two+Text:wght@500&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: STYLE + BADGE_STYLE }} />
    </head>
    <body>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="top">
        <div class="wrap">
          <a class="brand" href="/" aria-label="Road Sign Math Quiz">
            <picture>
              <source
                srcset={`${here.site}/brand/${BRAND_VERSION}/lockup-horizontal-white.svg`}
                media="(prefers-color-scheme: dark)"
              />
              <img
                src={`${here.site}/brand/${BRAND_VERSION}/lockup-horizontal-color.svg`}
                alt=""
                width={String(Math.round((LOCKUP_SIZE.width * 36) / LOCKUP_SIZE.height))}
                height="36"
              />
            </picture>
            <span class="qtab">QUIZ</span>
          </a>
          {player ? (
            <a class="me" href="/profile" aria-label={`${player.name || 'You'}: your profile`}>
              <span class="label">Your profile</span>
              <Face player={player} size={40} here={here} />
            </a>
          ) : (
            <a class="signin" href="/signin">
              Sign in
            </a>
          )}
        </div>
      </header>
      <main id="main" class="wrap">
        {children}
      </main>
      <footer class="foot">
        <div class="wrap">
          <a href={here.site}>roadsignmath.xyz</a>
          <a href={`${here.site}/rules`}>House rules</a>
          <a href={`${here.site}/privacy`}>Privacy</a>
          <a href={`${here.site}/support`}>Help</a>
        </div>
      </footer>
      {script && <script dangerouslySetInnerHTML={{ __html: script }} />}
      {count && <script defer src={TINYLYTICS_SCRIPT} data-site={QUIZ_TINYLYTICS_SITE} />}
    </body>
  </html>
);

/**
 * A player's face: their profile photo from the site (the small size, or the large one drawn
 * big), or their first letter in their colour (yellow takes ink).
 */
const Face: FC<{ player: Pick<Player, 'name' | 'avatarColor' | 'avatar'>; size: number; here: Here }> = ({
  player,
  size,
  here
}) =>
  player.avatar ? (
    <span aria-hidden="true" class="av pic" style={`width: ${size}px; height: ${size}px`}>
      <img src={photoUrl(here, player.avatar, size > 80 ? 'large' : 'thumb')} alt="" />
    </span>
  ) : (
    <span
      aria-hidden="true"
      class={player.avatarColor.toUpperCase() === '#F2B300' ? 'av ink' : 'av'}
      style={`width: ${size}px; height: ${size}px; background: ${player.avatarColor}; font-size: ${Math.round(size * 0.42)}px`}
    >
      {[...(player.name.trim() || '?')][0].toUpperCase()}
    </span>
  );

/** A way's math on a plate, drawn from its LaTeX, with its text as the label. */
const MathPlate: FC<{ text: string; big?: boolean; mini?: boolean }> = ({ text, big, mini }) => {
  const tex = texOf(text);
  return (
    <div class={mini ? 'plate mini' : big ? 'plate big' : 'plate'}>
      {tex === undefined ? (
        <div>{text}</div>
      ) : (
        <div role="img" aria-label={text} dangerouslySetInnerHTML={{ __html: mathSvg(tex) }} />
      )}
    </div>
  );
};

/** The dot between two facts, drawn as the site draws it: Overpass sets its · against the next word. */
const Sep = () => (
  <span class="sep">
    <span class="vh">, </span>
  </span>
);

/** An address as a reader says it: "roadsignmath.xyz/players/jamie". */
const address = (url: string) => url.replace(/^https?:\/\//, '');

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "Jamie", "Jamie and Tyler", "Jamie, Tyler and Tammy". */
const names = (list: string[]) =>
  list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

const finderNames = (sign: Sign) => names(sign.finders.map((f) => f.name));

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** The sign's photo, title and where and when it was found. */
const SignHead: FC<{ here: Here; sign: Sign; level?: 'h1' | 'h2' }> = ({ here, sign }) => {
  const photo = sign.photos[0];
  return (
    <>
      {photo && <img class="photo" src={photoUrl(here, photo.id, 'large')} alt={photo.alt} />}
      <div>
        <h1>{sign.title}</h1>
        <p class="meta">
          {sign.place.label}
          <Sep />
          Found {longDay(sign.foundOn)}
        </p>
      </div>
    </>
  );
};

/** The sign's numbers as tiles, each with what it was read from. Buttons on the solve page. */
const Tiles: FC<{ sign: Sign; buttons?: boolean }> = ({ sign, buttons }) => (
  <ul
    class={sign.numbers.length === 4 || sign.numbers.length > 6 ? 'tiles four' : 'tiles'}
    aria-label="Numbers on the sign"
  >
    {sign.numbers.map((n) => (
      <li>
        {buttons ? (
          <button
            type="button"
            class="nt"
            data-v={n.value}
            aria-label={n.text ? `${n.value}, read from ${n.text}` : n.value}
          >
            <b>{n.value}</b>
            {n.text && <small>{n.text}</small>}
          </button>
        ) : (
          <span class="nt">
            <b>{n.value}</b>
            {n.text && <small>{n.text}</small>}
          </span>
        )}
      </li>
    ))}
  </ul>
);

const KEYS: [string, string, string][] = [
  ['+', '+', 'Plus'],
  ['−', '−', 'Minus'],
  ['×', '×', 'Times'],
  ['÷', '÷', 'Divide'],
  ['^', 'xʸ', 'Power'],
  ['√', '√', 'Square root'],
  ['!', '!', 'Factorial'],
  ['(', '(', 'Open bracket'],
  [')', ')', 'Close bracket'],
  ['=', '=', 'Equals']
];

const Arrow = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M5 5l7 7-7 7M13 5l7 7-7 7" />
  </svg>
);
const Eye = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

// ---------------------------------------------------------------------------------------------
// Home and sign-in

export const HomePage: FC<{ here: Here; sample?: Sign; more: Sign[] }> = ({ here, sample, more }) => (
  <Frame here={here} title="Road Sign Math Quiz">
    <div class="stack" style="gap: 28px">
      <section class="hero">
        <div class="stack">
          <h1>Find the math in a road sign.</h1>
          <p class="lede">
            Every sign here was spotted on a real road trip. You get the photo and its numbers. The math is yours to
            find.
          </p>
          <a class="btn" href="/signin" style="max-width: 320px">
            Sign in to play
          </a>
          <p class="meta">Same account as the Road Sign Math app. No password: we email you a code and a link.</p>
        </div>
        {sample && (
          <article class="card" aria-label="A sample sign" style="overflow: hidden">
            {sample.photos[0] && (
              <img
                class="photo"
                style="border-radius: 0"
                src={photoUrl(here, sample.photos[0].id, 'large')}
                alt={sample.photos[0].alt}
              />
            )}
            <div class="stack" style="padding: 14px">
              <div>
                <strong style="font-size: 19px; font-weight: 900">{sample.title}</strong>
                <p class="meta">
                  {sample.place.label}
                  <Sep />
                  Found {longDay(sample.foundOn)}
                </p>
              </div>
              <Tiles sign={sample} />
              <div class="plate">
                <div class="empty">? = ?</div>
              </div>
            </div>
          </article>
        )}
      </section>
      <section aria-labelledby="how-h" class="stack" style="border-top: 1px solid var(--line); padding-top: 20px">
        <h2 id="how-h" class="h2">
          How it works
        </h2>
        <div class="steps">
          <div class="step">
            <span>1</span>
            <p>See a sign someone posted: its photo, its place and its numbers.</p>
          </div>
          <div class="step">
            <span>2</span>
            <p>Build math from those numbers until both sides match. It checks as you go.</p>
          </div>
          <div class="step">
            <span>3</span>
            <p>Send it. A way nobody found yet goes on the sign for everyone, with your name.</p>
          </div>
        </div>
      </section>
      {more.length > 0 && (
        <section class="figs" aria-label="More signs">
          {more.map((s) => (
            <figure>
              <img src={photoUrl(here, s.photos[0].id, 'large')} alt={s.photos[0].alt} loading="lazy" />
              <figcaption style="font-weight: 800">
                {s.title}{' '}
                <span class="meta" style="font-weight: 400">
                  <Sep />
                  {countWord(s.numbers.length)} {s.numbers.length === 1 ? 'number' : 'numbers'}
                </span>
              </figcaption>
            </figure>
          ))}
        </section>
      )}
    </div>
  </Frame>
);

export const SignInPage: FC<{ here: Here; error?: string; email?: string; to?: string }> = ({
  here,
  error,
  email,
  to
}) => (
  <Frame here={here} title="Sign in">
    <div class="stack narrow">
      <h1>Sign in to play</h1>
      <p class="lede">One account for Quiz and the Road Sign Math app. Already play in the app? Use the same email.</p>
      {error && (
        <p class="oops" role="alert">
          {error}
        </p>
      )}
      <form method="post" action="/signin" class="stack">
        <BackTo to={to} />
        <label for="em">Email</label>
        <input id="em" class="field" type="email" name="email" autocomplete="email" required value={email ?? ''} />
        <button class="btn" type="submit">
          Email me a code
        </button>
      </form>
      <p class="meta">
        No password. We email you a 6-digit code to type here, and a link that signs you in when you tap it. Players
        also get the occasional Road Sign Math newsletter, with a link to unsubscribe in each one.
      </p>
      <p class="meta">
        By signing in you agree to the <a href={`${here.site}/rules`}>house rules</a>.
      </p>
    </div>
  </Frame>
);

export const CodePage: FC<{
  here: Here;
  loginId: string;
  email: string;
  error?: string;
  sent?: boolean;
  to?: string;
}> = ({ here, loginId, email, error, sent, to }) => (
  <Frame here={here} title="Check your email">
    <div class="stack narrow">
      <h1>Check your email</h1>
      <p class="lede">
        We sent a code and a link to <strong>{email}</strong>. Type the code here, or tap the link in the email to sign
        in on this device.
      </p>
      {sent && (
        <p class="note" role="status">
          We sent another one. Use the code in the newest email.
        </p>
      )}
      {error && (
        <p class="oops" role="alert">
          {error}
        </p>
      )}
      <form method="post" action="/signin/code" class="stack">
        <input type="hidden" name="login" value={loginId} />
        <input type="hidden" name="email" value={email} />
        <BackTo to={to} />
        <label for="code">6-digit code</label>
        <input
          id="code"
          class="field code"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength={6}
          required
        />
        <button class="btn" type="submit">
          Sign in
        </button>
      </form>
      <div class="row">
        <form method="post" action="/signin">
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="again" value="1" />
          <BackTo to={to} />
          <button type="submit" class="txt">
            Send the email again
          </button>
        </form>
        <a class="txt" href={to ? `/signin?to=${to}` : '/signin'}>
          Use a different email
        </a>
      </div>
      <p class="meta">Not there? Look in spam for an email from Road Sign Math.</p>
    </div>
  </Frame>
);

/**
 * Where the email's link lands. Mail scanners follow links, so opening it changes nothing: the
 * button (pressed for you when scripts run) sends the link's token, and that signs you in.
 */
export const LinkPage: FC<{ here: Here; loginId: string; token: string; to?: string }> = ({
  here,
  loginId,
  token,
  to
}) => (
  <Frame
    here={here}
    title="Signing you in"
    count={false}
    script="document.getElementById('go').requestSubmit && document.getElementById('go').requestSubmit();"
  >
    <div class="stack narrow">
      <h1>Signing you in…</h1>
      <form id="go" method="post" action="/signin/link" class="stack">
        <input type="hidden" name="login" value={loginId} />
        <input type="hidden" name="token" value={token} />
        <BackTo to={to} />
        <button class="btn" type="submit">
          Sign in to Quiz
        </button>
      </form>
    </div>
  </Frame>
);

export const NamePage: FC<{ here: Here; player: Player; error?: string; to?: string }> = ({
  here,
  player,
  error,
  to
}) => (
  <Frame here={here} title="Your name" player={player}>
    <div class="stack narrow">
      <h1>You’re in. What should we call you?</h1>
      <p class="lede">Your name goes beside the ways you find, on the signs and in the app.</p>
      {error && (
        <p class="oops" role="alert">
          {error}
        </p>
      )}
      <form method="post" action="/name" class="stack">
        <BackTo to={to} />
        <label for="nm">Your name</label>
        <input id="nm" class="field" type="text" name="name" autocomplete="given-name" maxlength={40} required />
        <p class="meta">It also makes your page’s address on roadsignmath.xyz, for good.</p>
        <button class="btn" type="submit">
          Start playing
        </button>
      </form>
      <p class="note">Got the iPhone app? Sign in there with the same email and it’s all one player.</p>
    </div>
  </Frame>
);

// ---------------------------------------------------------------------------------------------
// A sign to solve

/** What the last send said, shown above the keypad. */
export type Said =
  | { kind: 'reordered'; tried: string; way: Way; by?: Player }
  | { kind: 'yours'; tried: string }
  | { kind: 'error'; message: string; tried?: string };

export const SolvePage: FC<{
  here: Here;
  player: Player;
  sign: Sign;
  on: OnSign;
  people: People;
  said?: Said;
}> = ({ here, player, sign, on, people, said }) => {
  const poster = people.get(sign.postedBy);
  const unsolved = on.ways.length === 0;
  return (
    <Frame here={here} title={sign.title} player={player} script={CHECKER_JS + '\n' + KEYPAD_JS}>
      <div class="solve">
        <div class="stack">
          {unsolved && (
            <span class="pill y" style="align-self: flex-start">
              Nobody’s found the math yet
            </span>
          )}
          <SignHead here={here} sign={sign} />
          {unsolved && poster?.name && (
            <p class="note">
              {firstName(poster.name)} posted this one without the math. Find the first way and you both earn{' '}
              <b>Tag Team</b>.
            </p>
          )}
        </div>
        <form id="solve" class="stack work" method="post" action={`${signPath(sign)}/solve`}>
          {said?.kind === 'reordered' && (
            <div class="callout" role="status">
              <strong>That’s {said.by?.name ? `${firstName(said.by.name)}’s` : 'a'} way, turned around.</strong>
              <MathPlate text={said.way.text} mini />
              <span>
                Swapping the sides of a × or a + doesn’t make a new way. Is there another? Taking away works
                differently: 7 − 4 = 3 and 7 − 3 = 4 are two ways.
              </span>
            </div>
          )}
          {said?.kind === 'yours' && (
            <div class="callout" role="status">
              <strong>You found that way already.</strong>
              <span>It’s on the sign with your name. Is there another?</span>
            </div>
          )}
          {said?.kind === 'error' && (
            <p class="oops" role="alert">
              {said.message.replace(/([^.!?])$/, '$1.')}
            </p>
          )}
          <div id="typed" class="stack">
            <label for="text">Your math</label>
            <input
              id="text"
              class="field"
              name="text"
              autocomplete="off"
              required
              value={said?.kind === 'error' ? (said.tried ?? '') : ''}
            />
            <p class="meta">Use the sign’s numbers and + − × ÷ ^ √ ! ( ) =.</p>
          </div>
          <div id="pad" class="stack" hidden>
            <div class="plate big">
              <div id="math" class="empty" aria-live="polite">
                Tap a number to start
              </div>
            </div>
            <div id="status" class="chk wait" aria-live="polite">
              <span class="said">Tap the numbers and signs to build the math.</span>
            </div>
            <Tiles sign={sign} buttons />
            <div class="keys" role="group" aria-label="Math keys">
              {KEYS.map(([k, face, label]) => (
                <button type="button" class="k" data-k={k} aria-label={label}>
                  {face}
                </button>
              ))}
              <button type="button" class="k del" data-k="del" aria-label="Delete">
                ⌫
              </button>
            </div>
            <p class="meta" style="font-size: 13px">
              On a keyboard, + - * / ^ ! ( ) = and Backspace work too. Numbers come only from the tiles.
            </p>
            {said && said.kind !== 'error' && <p class="meta">The numbers are back for another try.</p>}
          </div>
          <button id="send" class="btn" type="submit">
            Send
          </button>
          <div class="row">
            {unsolved ? (
              <span class="txt" aria-disabled="true" style="color: var(--soft)">
                No ways yet
              </span>
            ) : (
              <a class="txt" href={`${signPath(sign)}/ways`}>
                <Eye />
                Show the ways
              </a>
            )}
            <a class="txt" href={`/next?after=${encodeURIComponent(sign.id)}`}>
              Skip
              <Arrow />
            </a>
          </div>
        </form>
      </div>
    </Frame>
  );
};

/** The ways on a sign, each with who found it and who found it too. */
const WayList: FC<{ here: Here; ways: Way[]; on: OnSign; people: People; blocked: Set<string>; first?: boolean }> = ({
  here,
  ways,
  on,
  people,
  blocked,
  first
}) => (
  <>
    {ways.map((way) => {
      const by = people.get(way.playerId);
      const also = on.coFinds
        .filter((c) => c.wayId === way.id && !blocked.has(c.playerId))
        .map((c) => people.get(c.playerId))
        .filter((p): p is Player => !!p?.name);
      const isFirst = on.ways[0]?.id === way.id;
      return (
        <div class="way">
          <div class="who">
            {by && <Face player={by} size={28} here={here} />}
            <span>
              {by?.name ? (
                <>
                  Found by <b>{by.name}</b>
                </>
              ) : (
                'Found'
              )}
              {also.length > 0 && (
                <>
                  {' '}
                  <Sep />
                  also found by <b>{names(also.map((p) => p.name))}</b>
                </>
              )}
              {first && isFirst && (
                <>
                  <Sep />
                  the first way, {longDay(way.createdAt.slice(0, 10))}
                </>
              )}
            </span>
          </div>
          <MathPlate text={way.text} />
        </div>
      );
    })}
  </>
);

export const WaysPage: FC<{
  here: Here;
  player: Player;
  sign: Sign;
  on: OnSign;
  people: People;
  blocked: Set<string>;
}> = ({ here, player, sign, on, people, blocked }) => {
  const ways = on.ways.filter((w) => !blocked.has(w.playerId));
  return (
    <Frame here={here} title={`The ways on ${sign.title}`} player={player}>
      <div class="stack narrow">
        <div>
          <h1>The ways on this sign</h1>
          <p class="meta">
            {sign.title}
            <Sep />
            Found by {finderNames(sign)}
          </p>
        </div>
        {ways.length ? (
          <WayList here={here} ways={ways} on={on} people={people} blocked={blocked} first />
        ) : (
          <p class="lede">No ways yet. Yours could be the first.</p>
        )}
        <p class="note">
          Looking doesn’t count against you, and nothing is saved. Find a different way and it still goes on the sign.
        </p>
        <a class="btn" href={signPath(sign)}>
          Keep trying this one
        </a>
        <a class="btn ghost" href={`/next?after=${encodeURIComponent(sign.id)}`}>
          Next sign
        </a>
      </div>
    </Frame>
  );
};

// ---------------------------------------------------------------------------------------------
// What a send found

export const FoundPage: FC<{
  here: Here;
  player: Player;
  sign: Sign;
  on: OnSign;
  people: People;
  blocked: Set<string>;
  solve: Solve;
  badges: BadgeView[];
}> = ({ here, player, sign, on, people, blocked, solve, badges }) => {
  const next = `/next?after=${encodeURIComponent(sign.id)}`;
  const onSite = signUrl(here, sign);
  const others = on.ways.filter((w) => w.id !== solve.way.id && !blocked.has(w.playerId));
  const me = player.name || 'you';
  if (solve.kind === 'too') {
    const by = people.get(solve.way.playerId);
    const ways = on.ways.filter((w) => !blocked.has(w.playerId));
    return (
      <Frame here={here} title="You found it too" player={player}>
        <div class="stack narrow">
          <SignHead here={here} sign={sign} />
          <h2 class="h2" style="font-size: 26px">
            You found it too.
          </h2>
          <div class="tabbed">
            <div class="tab">
              <span>{by?.name ? `Same as ${firstName(by.name)}` : 'Same way'}</span>
            </div>
            <MathPlate text={solve.way.text} big />
          </div>
          {by?.name && (
            <p class="note">
              <span>
                {firstName(by.name)} found this way first. It now reads{' '}
                <b>
                  Found by {by.name}
                  <Sep />
                  also found by {me}
                </b>
                .
              </span>
            </p>
          )}
          <section aria-labelledby="all-h" class="stack" style="gap: 0">
            <h2 id="all-h" class="h2">
              All the ways on this sign
            </h2>
            <WayList here={here} ways={ways} on={on} people={people} blocked={blocked} />
            {ways.length === 1 && <p class="meta">That’s the only way so far. Maybe there’s another one.</p>}
          </section>
          <a class="btn" href={signPath(sign)}>
            Look for another way
          </a>
          <a class="btn ghost" href={next}>
            Next sign
          </a>
          <a class="txt" href={onSite}>
            See the sign on roadsignmath.xyz
          </a>
        </div>
      </Frame>
    );
  }
  const poster = people.get(sign.postedBy);
  const allUsed = solve.way.numbers.length === sign.numbers.length;
  const tagTeam = badges.find((b) => b.id === 'tag-team');
  const rest = badges.filter((b) => b.id !== 'tag-team');
  return (
    <Frame here={here} title={solve.kind === 'first' ? 'You found the math' : 'A new way'} player={player}>
      <div class="stack narrow">
        <SignHead here={here} sign={sign} />
        <h2 class="h2" style="font-size: 26px">
          {solve.kind === 'first' ? 'You found the math.' : 'Nobody had that one.'}
        </h2>
        <div class="tabbed">
          <div class="tab">
            <span>{solve.kind === 'first' ? 'First way' : 'New way'}</span>
          </div>
          <MathPlate text={solve.way.text} big />
        </div>
        {solve.kind === 'first' && poster?.name ? (
          <p class="lede">
            {firstName(poster.name)} spotted the sign and posted it without the math. You found it. The sign now reads{' '}
            <b>
              Found by {finderNames(sign)}
              <Sep />
              first way by {me}
            </b>
            .
          </p>
        ) : (
          <p class="lede">
            It’s on the sign now, for everyone, with your name beside it. Both sides come to {solve.way.value}
            {allUsed && sign.numbers.length > 1 ? `, and you used all ${countWord(sign.numbers.length)} numbers` : ''}.
          </p>
        )}
        {tagTeam && poster && (
          <section class="card stack" style="padding: 14px" aria-labelledby="tt-h">
            <span class="pill y" style="align-self: flex-start">
              New badge
            </span>
            <h2 id="tt-h" class="h2">
              Tag Team
            </h2>
            <p class="meta">{tagTeam.how}</p>
            {poster.name && (
              <p class="note">
                You and {firstName(poster.name)} both earn it. They see your way on their sign in the app.
              </p>
            )}
          </section>
        )}
        {rest.length > 0 && (
          <section aria-labelledby="b-h" class="stack">
            <h2 id="b-h" class="h2">
              Badges you earned
            </h2>
            <BadgeCards badges={rest} />
          </section>
        )}
        {others.length > 0 && (
          <section aria-labelledby="o-h" class="stack" style="gap: 0">
            <h2 id="o-h" class="h2">
              {others.length === 1 ? 'The other way on this sign' : 'The other ways on this sign'}
            </h2>
            <WayList here={here} ways={others} on={on} people={people} blocked={blocked} />
          </section>
        )}
        <a class="btn" href={next}>
          Next sign
        </a>
        {solve.kind === 'first' ? (
          <a class="btn ghost" href={playerUrl(here, player)}>
            See your badges
          </a>
        ) : (
          <a class="btn ghost" href={onSite}>
            See the sign on roadsignmath.xyz
          </a>
        )}
      </div>
    </Frame>
  );
};

// ---------------------------------------------------------------------------------------------
// The end, and the signs you've solved

export const AllDonePage: FC<{ here: Here; player: Player }> = ({ here, player }) => (
  <Frame here={here} title="Every sign done" player={player}>
    <div class="stack narrow">
      <div
        class="end"
        role="img"
        aria-label="A green guide sign: More signs on the road, with an arrow pointing ahead."
      >
        <div>
          <svg
            aria-hidden="true"
            width="44"
            height="44"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 20V5M5 11l7-7 7 7" />
          </svg>
          <span>MORE SIGNS</span>
          <span>ON THE ROAD</span>
        </div>
      </div>
      <h1>You’ve done every sign.</h1>
      <p class="lede">
        That’s all of them for now. The next one is out there on a road somewhere. Find it, snap it, and post it with
        the app.
      </p>
      <a class="btn" href={`${here.site}/app`}>
        Get the iPhone app
      </a>
      <a class="btn ghost" href={here.site}>
        See every sign on the map
      </a>
      <p class="meta">New signs show up here as players post them.</p>
    </div>
  </Frame>
);

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
const when = (at: string, now: Date) =>
  DAY_KEY.format(new Date(at)) === DAY_KEY.format(now) ? 'Today' : DAY.format(new Date(at));

const PILLS: Record<Solve['kind'], [string, string]> = {
  first: ['pill y', 'First way'],
  new: ['pill', 'New way'],
  too: ['pill g', 'You found it too']
};

export const SolvedPage: FC<{ here: Here; player: Player; solved: { sign: Sign; solve: Solve }[]; now: Date }> = ({
  here,
  player,
  solved,
  now
}) => (
  <Frame here={here} title="Signs you’ve solved" player={player}>
    <div class="stack narrow">
      <a class="txt" href="/next" style="align-self: flex-start">
        Back to the signs
      </a>
      <div>
        <h1>Signs you’ve solved</h1>
        <p class="lede">Only you see this list. The ways you found are on the signs for everyone.</p>
      </div>
      {solved.length ? (
        <ul class="solved">
          {solved.map(({ sign, solve }) => (
            <li>
              <a href={signUrl(here, sign)}>
                {sign.photos[0] && <img src={photoUrl(here, sign.photos[0].id, 'thumb')} alt="" loading="lazy" />}
                <span class="what">
                  <span>
                    <strong>{sign.title}</strong> <span class="meta">{when(solve.at, now)}</span>
                  </span>
                  <MathPlate text={solve.way.text} mini />
                  <span class={PILLS[solve.kind][0]}>{PILLS[solve.kind][1]}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p class="lede">Nothing yet. The signs you solve show up here.</p>
      )}
      <p class="meta">
        A tap opens the sign on roadsignmath.xyz.
        {player.name && (
          <>
            {' '}
            Your public page shows your ways and badges:{' '}
            <a href={playerUrl(here, player)}>{address(playerUrl(here, player))}</a>
          </>
        )}
      </p>
      <form method="post" action="/signout">
        <button type="submit" class="txt">
          Sign out
        </button>
      </form>
    </div>
  </Frame>
);

// ---------------------------------------------------------------------------------------------
// Your profile: what the app's You and Settings let a player change, on the web

/** What the last change on the profile page did, said once at its top. */
export type ProfileDone = 'photo' | 'removed' | 'saved';

const DONE: Record<ProfileDone, string> = {
  photo: 'Your new photo is up.',
  removed: 'Your photo is gone. Your first letter shows in its place.',
  saved: 'Saved.'
};

/** A trouble on the profile page, shown in the part it came from. */
export type ProfileTrouble = { part: 'photo' | 'about'; message: string };

const Oops: FC<{ message?: string }> = ({ message }) =>
  message ? (
    <p class="oops" role="alert">
      {message}
    </p>
  ) : null;

/**
 * Your profile, modelled on the app's You and its Settings: your photo (choose one, or remove
 * it), name and bio, your email (only you see it), your page on the site, the signs you've
 * solved, sign out and Delete my account. Every change is a form, so it works without scripts.
 */
export const ProfilePage: FC<{
  here: Here;
  player: Player;
  /** Whether the site has a page for them yet: it starts with a sign or a way. */
  hasPage: boolean;
  done?: ProfileDone;
  trouble?: ProfileTrouble;
  /** What they typed, kept when a save failed. */
  typed?: { name: string; bio: string };
}> = ({ here, player, hasPage, done, trouble, typed }) => {
  const page = playerUrl(here, player);
  return (
    <Frame here={here} title="Your profile" player={player}>
      <div class="stack narrow">
        <a class="txt" href="/next" style="align-self: flex-start">
          Back to the signs
        </a>
        <h1>Your profile</h1>
        {done && (
          <p class="note" role="status">
            {DONE[done]}
          </p>
        )}
        <section class="card prof" aria-label="How others see you">
          <Face player={player} size={84} here={here} />
          <span class="name">{player.name}</span>
          {hasPage ? (
            <a href={page}>{address(page)}</a>
          ) : (
            <p class="meta">Your page on roadsignmath.xyz starts with the first way you find.</p>
          )}
          {player.bio && <p class="bio">{player.bio}</p>}
        </section>

        <section class="part" aria-labelledby="ph-h">
          <h2 id="ph-h" class="h2">
            Profile photo
          </h2>
          <div class="photo-row">
            <Face player={player} size={56} here={here} />
            <p class="meta">
              {player.avatar
                ? 'Everyone sees it beside your signs and ways, and on your page.'
                : 'Your first letter shows until you add one.'}
            </p>
          </div>
          <Oops message={trouble?.part === 'photo' ? trouble.message : undefined} />
          <form method="post" action="/profile/photo" enctype="multipart/form-data" class="stack">
            <label for="photo">{player.avatar ? 'Choose a new photo' : 'Choose a photo'}</label>
            <input
              id="photo"
              class="field file"
              type="file"
              name="photo"
              accept="image/jpeg,image/png,image/webp"
              required
            />
            <p class="meta">
              A JPEG, PNG or WebP photo, up to {LIMITS.photoBytes / 1024 / 1024} MB. It’s cropped square from the
              middle, and Claude looks at it before it goes up.
            </p>
            <button class="btn" type="submit">
              {player.avatar ? 'Use this photo' : 'Add this photo'}
            </button>
          </form>
          {player.avatar && (
            <a class="txt bad" href="/profile/photo/remove" style="align-self: flex-start">
              Remove photo
            </a>
          )}
        </section>

        <section class="part" aria-labelledby="ab-h">
          <h2 id="ab-h" class="h2">
            Name and bio
          </h2>
          <Oops message={trouble?.part === 'about' ? trouble.message : undefined} />
          <form method="post" action="/profile" class="stack">
            <label for="nm">Name</label>
            <input
              id="nm"
              class="field"
              type="text"
              name="name"
              autocomplete="given-name"
              maxlength={NAME_MAX}
              required
              value={typed?.name ?? player.name}
            />
            <p class="meta">Your page’s address stays the same, so links to it keep working.</p>
            <label for="bio">Bio</label>
            <input
              id="bio"
              class="field"
              type="text"
              name="bio"
              maxlength={BIO_MAX}
              placeholder="Add a line about you"
              value={typed?.bio ?? player.bio ?? ''}
            />
            <p class="meta">
              It shows on your page, under your name, for everyone. Up to {BIO_MAX} characters; leave it empty to take
              it away.
            </p>
            <button class="btn" type="submit">
              Save
            </button>
          </form>
          {player.email && (
            <>
              <dl class="facts">
                <dt>Email</dt>
                <dd>{player.email}</dd>
              </dl>
              <p class="meta">Only you see your email. It’s for signing in and the occasional newsletter.</p>
            </>
          )}
        </section>

        <section class="part" aria-label="Your signs">
          <a class="txt" href="/solved" style="align-self: flex-start">
            Signs you’ve solved
          </a>
        </section>

        <section class="part" aria-label="Sign out">
          <form method="post" action="/signout">
            <button type="submit" class="btn ghost">
              Sign out
            </button>
          </form>
          <p class="meta">Your ways stay put. Sign in again with your email whenever you like.</p>
        </section>

        <section class="part" aria-label="Delete my account">
          <a class="btn danger" href="/profile/delete">
            Delete my account
          </a>
          <p class="meta">Deletes your account and everything you posted. It can’t be undone.</p>
        </section>
      </div>
    </Frame>
  );
};

/** Asks before the profile photo goes (the app asks the same). */
export const RemovePhotoPage: FC<{ here: Here; player: Player; error?: string }> = ({ here, player, error }) => (
  <Frame here={here} title="Remove your profile photo?" player={player}>
    <div class="stack narrow">
      <h1>Remove your profile photo?</h1>
      <Face player={player} size={84} here={here} />
      <p class="lede">Your first letter shows again in its place.</p>
      <Oops message={error} />
      <form method="post" action="/profile/photo/remove">
        <button class="btn danger" type="submit">
          Remove photo
        </button>
      </form>
      <a class="btn ghost" href="/profile">
        Keep it
      </a>
    </div>
  </Frame>
);

/** What deleting takes with it, in this player's numbers: the app's words (`MeView.deleteWords`). */
export function deleteWords(posted: number): string {
  const signs =
    posted === 0
      ? 'the ways you found'
      : posted === 1
        ? 'the sign you posted (with every way found on it), the ways you found on other signs'
        : `the ${posted} signs you posted (with every way found on them), the ways you found on other signs`;
  return `This deletes your account and everything it made: ${signs}, your name on signs other people posted, and your email. It can’t be undone.`;
}

/** Asks before the account goes, saying what goes with it. */
export const DeletePage: FC<{ here: Here; player: Player; posted: number; error?: string }> = ({
  here,
  player,
  posted,
  error
}) => (
  <Frame here={here} title="Delete your account?" player={player}>
    <div class="stack narrow">
      <h1>Delete your account?</h1>
      <p class="lede">{deleteWords(posted)}</p>
      <p class="meta">
        It’s the same account as the app, so it’s gone there too. Your email leaves the newsletter, and anything deleted
        is gone from the backups within a year.
      </p>
      <Oops message={error} />
      <form method="post" action="/profile/delete">
        <button class="btn danger" type="submit">
          Delete my account
        </button>
      </form>
      <a class="btn ghost" href="/profile">
        Keep it
      </a>
    </div>
  </Frame>
);

/** A page for an error a player can do something about, or can't. */
export const MessagePage: FC<{ here: Here; player?: Player; title: string; message: string }> = ({
  here,
  player,
  title,
  message
}) => (
  <Frame here={here} title={title} player={player}>
    <div class="stack narrow">
      <h1>{title}</h1>
      <p class="lede">{message}</p>
      <a class="btn" href="/">
        Back to Quiz
      </a>
    </div>
  </Frame>
);
