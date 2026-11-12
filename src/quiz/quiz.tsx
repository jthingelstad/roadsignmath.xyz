// Road Sign Math Quiz at quiz.roadsignmath.xyz (docs: AGENTS.md, Quiz). It answers only through
// Quiz's distribution (src/front.ts); the site never serves these pages, and Quiz never serves
// the site's or the API.
//
// Jamie opened it on 2026-11-12. With `QUIZ_OPEN` false, every address answers the same short page
// saying Quiz is coming, kept out of search engines.
//
// Open, it is a handful of server-drawn pages (src/quiz/pages.tsx) over the same store and the
// same rules as the app: a sign at a time to solve, for anyone (Jamie, 2026-11-12: show the sign and
// the keypad, and ask for sign-in at Send, keeping the math). Sending asks a signed-out player to
// sign in by email (the same account) and give a name, carrying their math through it; a way goes
// through `solveSign` exactly as the app's does, marked `quiz`. Nothing is cached anywhere, and
// nothing a GET does changes anything; every POST must come from Quiz's own pages
// (src/quiz/session.ts). Nothing is kept for a signed-out player and no cookie is set before they
// sign in: their math rides in the form they post, then on the sign-in's own row.

import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { LIMITS } from '../api/contract.ts';
import { ApiError } from '../api/errors.ts';
import { earnedBadgeView, isPublic, signPath } from '../api/views.ts';
import type { Viewer } from '../auth/auth.ts';
import { sameWayKey } from '../domain/equation.ts';
import { isUlid } from '../domain/ids.ts';
import type { Player, Sign } from '../domain/types.ts';
import { REORDERED, YOURS, checkWay, solveSign } from '../posting/posting.ts';
import { product } from '../product.ts';
import {
  badgesFrom,
  credits,
  draw,
  loadQuiz,
  onSigns,
  smallFirst,
  solvedBy,
  stillToTry,
  type OnSign,
  type Solve
} from './data.ts';
import {
  AllDonePage,
  FoundPage,
  HomePage,
  MessagePage,
  NamePage,
  SignInPage,
  SolvePage,
  ShareCard,
  SolvedPage,
  WaysPage,
  type Here,
  type Said
} from './pages.tsx';
import { mountAccount } from './account.tsx';
import { forget, fromOrigin, jarFor, sessionViewer } from './session.ts';
import { SITE_SIGNIN_OPEN } from '../web/account.tsx';
import { quizCard } from './share.ts';
import { whatSwapped } from './swapped.ts';
import { queryOf, signByKey } from '../web/permalinks.ts';

/**
 * Whether Quiz is open. Jamie's call: opened 2026-11-12 ("Approved: open Quiz on
 * quiz.roadsignmath.xyz by setting QUIZ_OPEN to true"). Set false, every address answers the
 * coming-soon page.
 */
export const QUIZ_OPEN = true;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const PRIVATE = { 'Cache-Control': 'no-store' };

/** Quiz's own origin: its own when given, else the site's with `quiz.` in front. */
export const quizOrigin = (site: string): string => {
  const url = new URL(site);
  if (url.hostname === 'localhost' || /^[\d.]+$/.test(url.hostname)) return site;
  return `${url.protocol}//quiz.${url.host}`;
};

type QuizOptions = ApiOptions & { clientIp: (c: Context) => string };

/**
 * The sign a player came to try (a link from a sign's page on the site), carried through signing
 * in as `to` so they land on it after. Only a sign's id, or a slug as links and emails from before
 * ids carried, so it can only ever lead to a Quiz sign page (a slug goes on to the id's with a 301).
 */
const backTo = (to: string | undefined): string | undefined =>
  to && (isUlid(to) || (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to) && to.length <= 80)) ? to : undefined;
const withTo = (path: string, to: string | undefined) => (to ? `${path}?to=${to}` : path);
// `to` is a sign's slug, or an id from a link of 12 November 2026, whose address goes on to the slug's.
const onward = (to: string | undefined) => (to ? `/signs/${to}` : '/next');

/**
 * The math a signed-out player built on this sign, carried through signing in: the text as they
 * sent it, only when it is at most `LIMITS.wayMax` long and passes the same check as any way on the
 * sign (true, only its numbers, every one). Anything else is dropped. It is untrusted input: shown
 * escaped, never logged, and only ever sent by the player's own tap, through `solveSign`.
 */
function carriable(sign: Sign | undefined, raw: unknown): string | undefined {
  if (!sign || typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || text.length > LIMITS.wayMax) return undefined;
  try {
    checkWay(text, sign.numbers);
    return text;
  } catch {
    return undefined;
  }
}

export function createQuiz(options: QuizOptions): Hono {
  const quiz = new Hono();
  if (!(options.quizOpen ?? QUIZ_OPEN)) {
    quiz.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, NO_STORE));
    quiz.all('*', (c) => c.html(soon(options.urls.site), 200, NO_STORE));
    return quiz;
  }

  const { store, urls } = options;
  const here: Here = { site: urls.site, quiz: urls.quiz ?? quizOrigin(urls.site) };
  // One sign-in for Quiz and the site while the site's is open (D5a); else Quiz's own cookie.
  const jar = jarFor(urls.site, options.siteSignInOpen ?? SITE_SIGNIN_OPEN);
  /**
   * A page, naming the share card (Home's, src/quiz/share.ts) in its head. A card that can't be
   * worked out leaves the page without one, never in the way.
   */
  const page = async (c: Context, body: Child, status: 200 | 400 | 404 | 409 | 413 | 422 | 429 | 503 = 200) => {
    const card = await quizCard(store).catch(() => undefined);
    const html = (<ShareCard.Provider value={card}>{body}</ShareCard.Provider>).toString();
    return c.html('<!doctype html>' + html, status, PRIVATE);
  };
  const go = (c: Context, path: string) => c.redirect(path, 303);
  const form = async (c: Context) => {
    const body = await c.req.parseBody();
    return (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
  };

  /** The signed-in player, or a redirect: to sign in, or to give a name first, then back to `to`. */
  async function playing(c: Context, to?: string): Promise<Viewer | Response> {
    const viewer = await sessionViewer(store, c, jar);
    if (!viewer) return go(c, withTo('/signin', to));
    if (!viewer.player.name) return go(c, withTo('/name', to));
    return viewer;
  }

  /** A shown sign by its slug or id (`to`), as a signed-out player sees them. */
  const signNamed = async (to: string | undefined) =>
    to ? signByKey((await loadQuiz(store, undefined)).signs, to)?.found : undefined;

  quiz.use('*', async (c, next) => {
    if (c.req.method === 'POST' && !fromOrigin(c, here.quiz)) {
      return page(
        c,
        <MessagePage here={here} title="That didn’t come from Quiz" message="Go back to Quiz and try again." />,
        400
      );
    }
    await next();
  });

  quiz.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /$\nDisallow: /\n', 200, PRIVATE));

  quiz.get('/', async (c) => {
    if (await sessionViewer(store, c, jar)) return go(c, '/next');
    const data = await loadQuiz(store, undefined);
    const withPhoto = data.signs.filter((s) => s.photos.length && s.numbers.length);
    return page(c, <HomePage here={here} sample={withPhoto[0]} more={withPhoto.slice(1, 4)} />);
  });

  // ---- Signing in, the name step and sign out (src/quiz/account.tsx, shared with the site)

  /**
   * Where carried math lands once they are in, drawn as the answer to the POST that signed them in
   * (or gave the name) so the math never goes in an address: the name page first for a new player,
   * carrying it on; then the sign with the math back on the keypad, for one tap of Send. Nothing is
   * sent for them. Math the sign no longer takes is dropped, and they land on the sign as usual.
   */
  async function landWith(c: Context, player: Player, to: string, raw: string) {
    if (!player.name) {
      const math = carriable(await signNamed(to), raw);
      return page(c, <NamePage here={here} player={player} to={to} math={math} />);
    }
    const got = await signFor(c, player, to);
    if (got.missing) return got.missing;
    const math = carriable(got.sign, raw);
    if (!math) return go(c, signPath(got.sign));
    return solvePage(c, player, got.sign, got.on, got.data, undefined, 200, math);
  }

  // ---- Playing

  quiz.get('/next', async (c) => {
    // Anyone may play: signed out, every shown sign with numbers is in the draw, small ones first
    // as for a new player. Signed in without a name, the name comes first.
    const viewer = await sessionViewer(store, c, jar);
    if (viewer && !viewer.player.name) return go(c, '/name');
    const player = viewer?.player;
    const data = await loadQuiz(store, player);
    const on = await onSigns(store, data.signs);
    const left = stillToTry(data, on, player?.id ?? '');
    const after = c.req.query('after');
    const solved = player ? solvedBy(data, on, player.id).length : 0;
    const sign = draw(smallFirst(left, solved, after), after);
    // Leaving a sign they haven't solved for another is a skip (Next after a send leaves a solved one).
    if (after && left.some((s) => s.id === after || s.slug === after)) {
      product({ action: 'skip', front: 'quiz', ...(!player && { guest: true }) });
    }
    if (!sign) return page(c, <AllDonePage here={here} player={player} />);
    return go(c, signPath(sign));
  });

  /**
   * A sign page's old address, by slug, or its id in another case: a 301 to the same page at the
   * sign's id, keeping the rest of the path and the query (`?way=`). Undefined when the key is the
   * id, or names no shown sign (the page then answers as it always has).
   */
  async function moved(c: Context, rest = ''): Promise<Response | undefined> {
    const named = signByKey((await store.allSigns()).filter(isPublic), c.req.param('key') ?? '');
    if (!named || named.canonical) return undefined;
    c.header('Cache-Control', PRIVATE['Cache-Control']);
    return c.redirect(`${signPath(named.found)}${rest}${queryOf(c)}`, 301);
  }

  /** A shown sign the player sees, by slug (or an id, from a link of 12 November 2026), with its ways
   * and co-finds, or a not-found page. */
  async function signFor(c: Context, player: Player | undefined, key = c.req.param('key') ?? '') {
    const data = await loadQuiz(store, player);
    const sign = signByKey(data.signs, key)?.found;
    if (!sign) return { missing: gone(c, player, key, c.req.method === 'POST') };
    const [ways, coFinds] = await Promise.all([store.listWays(sign.id), store.listCoFinds(sign.id)]);
    // A blocked player's ways are left out, as the API leaves them for this reader.
    const on: OnSign = { ways: ways.filter((w) => !data.blocked.has(w.playerId)), coFinds };
    return { data, sign, on };
  }

  /**
   * A sign that isn't in Quiz: taken down, hidden or never there (its poster deleted it, a report
   * hid it, or a link names nothing). Said plainly, with another sign to try.
   */
  const gone = (c: Context, player: Player | undefined, key: string, sending: boolean) =>
    page(
      c,
      <MessagePage
        here={here}
        player={player}
        title="This sign isn’t here any more"
        message={`It was taken down or hidden, or the link is wrong, so it isn’t in Quiz.${sending ? ' Your math wasn’t sent.' : ''} There are other signs to try.`}
        action={{ href: `/next?after=${encodeURIComponent(key)}`, label: 'Try another sign' }}
      />,
      404
    );

  const solvePage = (
    c: Context,
    player: Player | undefined,
    sign: Sign,
    on: OnSign,
    data: Awaited<ReturnType<typeof loadQuiz>>,
    said?: Said,
    status: 200 | 400 | 409 | 429 = 200,
    carried?: string
  ) =>
    page(
      c,
      <SolvePage here={here} player={player} sign={sign} on={on} people={data.people} said={said} carried={carried} />,
      status
    );

  quiz.get('/signs/:key', async (c) => {
    const old = await moved(c);
    if (old) return old;
    // Everyone sees the sign and the keypad; sign-in is asked for at Send. A signed-in player with
    // no name gives one first, as before.
    const viewer = await sessionViewer(store, c, jar);
    if (viewer && !viewer.player.name) return go(c, withTo('/name', backTo(c.req.param('key') ?? '')));
    const got = await signFor(c, viewer?.player);
    if (got.missing) return got.missing;
    return solvePage(c, viewer?.player, got.sign, got.on, got.data);
  });

  /**
   * A signed-out Send: the math is checked as any way is (a mistake is said on the sign, as for a
   * player), then the sign-in page asks for their email, carrying the math and the sign. Nothing is
   * written and no cookie is set.
   */
  async function guestSend(c: Context) {
    const got = await signFor(c, undefined);
    if (got.missing) return got.missing;
    const { sign, on, data } = got;
    const text = (await form(c))('text').trim();
    if (text.length > LIMITS.wayMax) {
      return solvePage(c, undefined, sign, on, data, { kind: 'error', message: TOO_LONG }, 400);
    }
    try {
      checkWay(text, sign.numbers);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'bad_request') throw err;
      return solvePage(c, undefined, sign, on, data, { kind: 'error', message: err.message, tried: text }, 400);
    }
    product({ action: 'signin-ask', front: 'quiz' });
    return page(c, <SignInPage here={here} to={sign.slug} math={text} />);
  }

  quiz.post('/signs/:key/solve', async (c) => {
    const signedIn = await sessionViewer(store, c, jar);
    if (!signedIn) return guestSend(c);
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const got = await signFor(c, viewer.player);
    if (got.missing) return got.missing;
    const { sign, on, data } = got;
    const text = (await form(c))('text').trim();
    try {
      const solved = await solveSign(options, viewer.player, sign, { text }, 'quiz');
      return go(c, `${signPath(sign)}/found?way=${encodeURIComponent(solved.way.id)}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Gone between the page's read and the write.
      if (err.code === 'not_found') return gone(c, viewer.player, sign.slug, true);
      if (err.code === 'conflict' && err.message === REORDERED) {
        const key = sameWayKey(text);
        const way = on.ways.find((w) => sameWayKey(w.text) === key);
        if (way) {
          const by = data.people.get(way.playerId);
          const said: Said = { kind: 'reordered', tried: text, way, by, swapped: whatSwapped(text, way.text) };
          return solvePage(c, viewer.player, sign, on, data, said, 409);
        }
      }
      if (err.code === 'conflict' && err.message === YOURS) {
        return solvePage(c, viewer.player, sign, on, data, { kind: 'yours', tried: text }, 409);
      }
      if (err.code === 'bad_request' || err.code === 'conflict' || err.code === 'rate_limited') {
        const status = err.code === 'bad_request' ? 400 : err.code === 'conflict' ? 409 : 429;
        return solvePage(
          c,
          viewer.player,
          sign,
          on,
          data,
          { kind: 'error', message: err.message, tried: text },
          status
        );
      }
      throw err;
    }
  });

  quiz.get('/signs/:key/found', async (c) => {
    const old = await moved(c, '/found');
    if (old) return old;
    const viewer = await playing(c, backTo(c.req.param('key') ?? ''));
    if (viewer instanceof Response) return viewer;
    const got = await signFor(c, viewer.player);
    if (got.missing) return got.missing;
    const { sign, on, data } = got;
    const solve = solveFor(sign, on, viewer.player.id, c.req.query('way'));
    if (!solve) return go(c, signPath(sign));
    const all = await onSigns(store, data.signs);
    const badges =
      solve.kind === 'too' ? [] : badgesFrom(data, all, viewer.player.id, sign).map((e) => earnedBadgeView(urls, e));
    return page(
      c,
      <FoundPage
        here={here}
        player={viewer.player}
        sign={sign}
        on={on}
        people={data.people}
        blocked={data.blocked}
        solve={solve}
        badges={badges}
      />
    );
  });

  quiz.get('/signs/:key/ways', async (c) => {
    const old = await moved(c, '/ways');
    if (old) return old;
    const viewer = await playing(c, backTo(c.req.param('key') ?? ''));
    if (viewer instanceof Response) return viewer;
    const got = await signFor(c, viewer.player);
    if (got.missing) return got.missing;
    return page(
      c,
      <WaysPage
        here={here}
        player={viewer.player}
        sign={got.sign}
        on={got.on}
        people={got.data.people}
        blocked={got.data.blocked}
      />
    );
  });

  quiz.get('/solved', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const data = await loadQuiz(store, viewer.player);
    const solved = solvedBy(data, await onSigns(store, data.signs), viewer.player.id);
    const { hasPage } = await profileOf(viewer.player);
    return page(
      c,
      <SolvedPage
        here={here}
        player={viewer.player}
        solved={solved}
        now={new Date()}
        hasPage={hasPage}
        at={playingAt(c)}
      />
    );
  });

  // ---- Your profile: photo, name and bio, sign out, and Delete my account, as the app's settings
  // (src/quiz/account.tsx, shared with the site)

  /** Whether the site has a page for the player yet (a sign or a way of theirs), and the signs they posted. */
  async function profileOf(player: Player) {
    const signs = await store.allSigns();
    const shown = signs.filter(isPublic);
    const on = await onSigns(store, shown);
    const hasPage = shown.some(
      (s) =>
        credits(s, player.id) ||
        on.get(s.id)?.ways.some((w) => w.playerId === player.id) ||
        on.get(s.id)?.coFinds.some((f) => f.playerId === player.id)
    );
    return { hasPage, posted: signs.filter((s) => s.postedBy === player.id).length };
  }

  mountAccount(quiz, {
    options,
    here,
    jar,
    page,
    backTo,
    onward,
    carry: {
      fromForm: async (to, raw) => carriable(await signNamed(to), raw),
      land: landWith
    },
    profileOf,
    at: playingAt,
    deletedWords: 'It’s gone, with everything it made, here and in the app. Thanks for playing Road Sign Math.'
  });

  quiz.notFound((c) =>
    page(c, <MessagePage here={here} title="Nothing here" message="That page isn’t part of Quiz." />, 404)
  );

  quiz.onError((err, c) => {
    if (err instanceof ApiError && err.code === 'unauthorized') {
      forget(c, jar);
      return go(c, '/signin');
    }
    console.error(err);
    return c.html(
      '<!doctype html>' +
        (
          <MessagePage
            here={here}
            title="Something broke"
            message="Something went wrong on our side. Try again in a minute."
          />
        ).toString(),
      500,
      PRIVATE
    );
  });

  return quiz;
}

/** What a signed-out Send says when the math is longer than any way may be. */
const TOO_LONG = 'That math is too long to send.';

/** The sign being played (`?at=`, a checked slug or id) on the profile and solved pages. */
const playingAt = (c: Context) => backTo(c.req.query('at'));

/** How the player solved this sign with the way named, or (no way named) most recently. */
function solveFor(sign: Sign, on: OnSign, playerId: string, wayId: string | undefined): Solve | undefined {
  const at = on.ways.findIndex((w) => w.id === wayId);
  if (at < 0) return undefined;
  const way = on.ways[at];
  if (way.playerId === playerId) {
    return { kind: at === 0 && !credits(sign, playerId) ? 'first' : 'new', way, at: way.createdAt };
  }
  const also = on.coFinds.find((f) => f.wayId === way.id && f.playerId === playerId);
  return also && { kind: 'too', way, at: also.createdAt };
}

function soon(site: string): string {
  return (
    '<!doctype html>' +
    (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex, nofollow" />
          <title>Road Sign Math Quiz</title>
          <link rel="icon" href={`${site}/favicon.svg`} type="image/svg+xml" />
          <style>{`
            :root { color-scheme: light dark; --ink: #18201C; --paper: #F7F5EF; --green: #006348; }
            @media (prefers-color-scheme: dark) { :root { --ink: #F7F5EF; --paper: #18201C; --green: #5FC29C; } }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
              box-sizing: border-box; background: var(--paper); color: var(--ink);
              font: 18px/1.5 system-ui, -apple-system, sans-serif; text-align: center; }
            h1 { font-size: 28px; margin: 0 0 8px; }
            a { color: var(--green); font-weight: 700; }
          `}</style>
        </head>
        <body>
          <main>
            <h1>Road Sign Math Quiz</h1>
            <p>Coming soon.</p>
            <p>
              <a href={site}>See the signs on roadsignmath.xyz</a>
            </p>
          </main>
        </body>
      </html>
    ).toString()
  );
}
