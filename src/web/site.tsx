// The website's first pages: every shown sign, newest first, one page per sign, and one per
// player with their badges. Read-only, public, and built from the same store and views as the
// API. The designed pages (the map, players, sign-in) replace these in later steps.

import { Hono } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { earnedBadges } from '../domain/badges.ts';
import type { Way } from '../domain/types.ts';
import {
  byNewest,
  earnedBadgeView,
  isPublic,
  playerStats,
  playerView,
  signDetail,
  signSummary,
  type People
} from '../api/views.ts';
import { BADGE_STYLE, BadgeRow } from './badges.tsx';
import { mathSvg } from './math.ts';
import { TINYLYTICS_SCRIPT, TINYLYTICS_SITE } from './tinylytics.ts';

type Summary = ReturnType<typeof signSummary>;

const STYLE = `
:root { --ink: #1d2a24; --soft: #5b6b63; --line: #d9e0dc; --paper: #fbfcfb; --green: #0b6e3f; --card: #fff;
  --heart: #b01c33; --heart-soft: #fbe9ec; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e8efeb; --soft: #9fb0a7; --line: #2c3a33; --paper: #121a16; --green: #4fbf86; --card: #18221d;
    --heart: #e0566b; --heart-soft: #3a1d23; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 16px/1.5 Overpass, system-ui, -apple-system, sans-serif; }
a { color: inherit; }
header { background: var(--green); color: #fff; padding: 18px 16px; }
header a { text-decoration: none; font-weight: 800; font-size: 22px; letter-spacing: .02em; }
header p { margin: 2px 0 0; opacity: .9; font-size: 15px; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
.grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.card a { text-decoration: none; display: block; }
.card img { width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: var(--line); }
.card div { padding: 10px 12px 12px; }
.title { font-weight: 700; margin: 0; }
.math { display: block; font-size: 19px; line-height: 1.3; color: var(--green); margin: 6px 0; }
.math svg { max-width: 100%; height: auto; }
.meta { color: var(--soft); font-size: 14px; margin: 0; }
.photo { width: 100%; height: auto; border-radius: 10px; display: block; margin: 0 0 12px; }
h1 { margin: 8px 0 4px; font-size: 28px; line-height: 1.2; }
.ways { padding-left: 0; list-style: none; }
.ways li { padding: 8px 0; border-top: 1px solid var(--line); }
footer { color: var(--soft); font-size: 14px; text-align: center; padding: 24px 16px 40px; }
h2 { font-size: 20px; margin: 20px 0 4px; }
${BADGE_STYLE}`;

/** The heart buttons, only on pages that load Tinylytics' script (it fills them in). */
const HEART_STYLE = `
.card .foot { padding: 0 12px 12px; }
.tinylytics_kudos { font: inherit; font-size: 15px; line-height: 1; color: var(--ink); background: transparent;
  border: 1px solid var(--line); border-radius: 999px; padding: 7px 12px; min-width: 56px; min-height: 32px;
  cursor: pointer; }
.tinylytics_kudos:empty::before { content: "❤️"; opacity: .45; }
.tinylytics_kudos:hover { border-color: var(--heart); }
.tinylytics_kudos.did_select { border-color: var(--heart); background: var(--heart-soft); cursor: default; }
.hearts { margin: 4px 0 12px; }
`;

// `count` adds Tinylytics' counter. The sign-in page leaves it out: its URL carries the link's token.
const Page: FC<PropsWithChildren<{ title: string; description: string; count?: boolean }>> = ({
  title,
  description,
  count = true,
  children
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content={description} />
      <style dangerouslySetInnerHTML={{ __html: count ? STYLE + HEART_STYLE : STYLE }} />
    </head>
    <body>
      <header>
        <a href="/">Road Sign Math</a>
        <p>Driving + Math = Fun. Find a sign whose numbers make a true equation.</p>
      </header>
      <main>{children}</main>
      <footer>The iPhone app, where you post your own signs, is on its way.</footer>
      {count && <script defer src={TINYLYTICS_SCRIPT} data-site={TINYLYTICS_SITE} />}
    </body>
  </html>
);

/** A way's math, drawn from its LaTeX; the plain text when there is none. */
const Equation: FC<{ way: { text: string; tex: string | null } }> = ({ way }) =>
  way.tex === null ? (
    <span class="math">{way.text}</span>
  ) : (
    <span class="math" role="img" aria-label={way.text} dangerouslySetInnerHTML={{ __html: mathSvg(way.tex) }} />
  );

const finders = (s: Summary): string => s.finders.map((f) => f.name).join(', ');

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

/**
 * Tinylytics' kudos button, filled in by its script with ❤️ and the count. The count is kept at
 * the sign's path, the same one the app's hearts use, so both add up together.
 */
const Heart: FC<{ sign: { slug: string; title: string } }> = ({ sign }) => (
  <button
    type="button"
    class="tinylytics_kudos"
    data-path={`/signs/${sign.slug}`}
    aria-label={`Heart the ${sign.title} sign`}
  />
);

const Card: FC<{ sign: Summary }> = ({ sign }) => {
  const photo = sign.photos[0];
  return (
    <li class="card">
      <a href={`/signs/${sign.slug}`}>
        {photo && (
          <img src={photo.thumb_url} alt={photo.alt} width={photo.width} height={photo.height} loading="lazy" />
        )}
        <div>
          <p class="title">{sign.title}</p>
          {sign.first_way && <Equation way={sign.first_way} />}
          <p class="meta">
            {sign.place.label} · {finders(sign)}
          </p>
        </div>
      </a>
      <div class="foot">
        <Heart sign={sign} />
      </div>
    </li>
  );
};

/** The pages, mounted beside the API. Every page is public and cached for a minute. */
export function createSite({ store, urls }: Pick<ApiOptions, 'store' | 'urls'>): Hono {
  const site = new Hono();
  const people = async (): Promise<People> => new Map((await store.allPlayers()).map((p) => [p.id, p]));
  site.use(async (c, next) => {
    await next();
    if (c.res.headers.get('Cache-Control') === 'no-store') return;
    c.header('Cache-Control', c.res.status === 200 ? 'public, max-age=60' : 'no-store');
  });

  // The sign-in link opens the app on an iPhone that has it (src/web/apple.ts). Anywhere else it
  // lands here, which says where to use it. The link's token never appears in the page, and the
  // page is never cached under it.
  site.get('/signin', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(
      <Page title="Sign in · Road Sign Math" description="Sign in to Road Sign Math in the iPhone app." count={false}>
        <h1>Sign in on your iPhone</h1>
        <p>
          This link signs you in to the Road Sign Math app. Open it on the iPhone where the app is installed, or type
          the 6-digit code from the same email into the app.
        </p>
        <p>
          <a href="/">See the signs</a>
        </p>
      </Page>
    );
  });

  site.get('/', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic).sort(byNewest);
    return c.html(
      <Page title="Road Sign Math" description="Road signs whose numbers make a true equation, found on road trips.">
        <ul class="grid">
          {shown.map((s) => (
            <Card sign={signSummary(urls, everyone, s)} />
          ))}
        </ul>
      </Page>
    );
  });

  site.get('/signs/:slug', async (c) => {
    const found = (await store.allSigns()).find((s) => s.slug === c.req.param('slug'));
    if (!found || !isPublic(found)) return c.notFound();
    const [ways, everyone] = await Promise.all([store.listWays(found.id), people()]);
    const sign = signDetail(urls, everyone, found, ways);
    const description = `${sign.title}, ${sign.place.label}${sign.first_way ? `: ${sign.first_way.text}` : ''}`;
    return c.html(
      <Page title={`${sign.title} · Road Sign Math`} description={description}>
        {sign.photos.map((p) => (
          <img class="photo" src={p.url} alt={p.alt} width={p.width} height={p.height} />
        ))}
        <h1>{sign.title}</h1>
        <p class="meta">
          {sign.place.label} · found {sign.found_on} by <Finders sign={sign} />
        </p>
        <p class="hearts">
          <Heart sign={sign} />
        </p>
        {sign.caption && <p>{sign.caption}</p>}
        <ul class="ways">
          {sign.ways.map((w) => (
            <li>
              <Equation way={w} />
              {w.by && (
                <p class="meta">
                  by <a href={`/players/${w.by.handle}`}>{w.by.name || w.by.handle}</a>
                </p>
              )}
            </li>
          ))}
        </ul>
        <p>
          <a href="/">All signs</a>
        </p>
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
    // A player with nothing on the map yet has no page.
    if (!stats.sign_count && !badges.length) return c.notFound();
    const view = playerView(urls, player, shown);
    const since = view.first_year ? ` since ${view.first_year}` : '';
    const where = view.states.length ? ` in ${view.states.join(', ')}` : '';
    return c.html(
      <Page title={`${player.name} · Road Sign Math`} description={`Road signs ${player.name} found${since}.`}>
        <h1>{player.name}</h1>
        {player.bio && <p>{player.bio}</p>}
        <p class="meta">
          Finding signs{where}
          {since}.
        </p>
        {badges.length > 0 && (
          <>
            <h2>Badges</h2>
            <BadgeRow badges={badges} />
          </>
        )}
        {stats.sign_count > 0 && (
          <>
            <h2>Signs</h2>
            <ul class="grid">
              {stats.signs.map((s) => (
                <Card sign={signSummary(urls, everyone, s)} />
              ))}
            </ul>
          </>
        )}
      </Page>
    );
  });

  return site;
}
