// Road Sign Math Quiz at quiz.roadsignmath.xyz (docs: AGENTS.md, Quiz). It answers only through
// Quiz's distribution (src/front.ts); the site never serves these pages, and Quiz never serves
// the site's or the API.
//
// Jamie opened it on 2026-11-12. With `QUIZ_OPEN` false, every address answers the same short page
// saying Quiz is coming, kept out of search engines.
//
// Open, it is a handful of server-drawn pages (src/quiz/pages.tsx) over the same store and the
// same rules as the app: sign in by email (the same account), give a name, then a sign at a time
// to solve. A way goes through `solveSign` exactly as the app's does, marked `quiz`. Nothing is
// cached anywhere, and nothing a GET does changes anything; every POST must come from Quiz's own
// pages (src/quiz/session.ts).

import { Hono, type Context } from 'hono';
import type { ApiOptions } from '../api/app.ts';
import { LIMITS } from '../api/contract.ts';
import { ApiError, STATUS, fail } from '../api/errors.ts';
import { earnedBadgeView, isPublic, signPath } from '../api/views.ts';
import { newsletterAtSignIn, removeAvatar, removePlayer, setAvatar, updateMe } from '../auth/account.ts';
import { finishSignIn, signOut, startSignIn, type Viewer } from '../auth/auth.ts';
import { sameWayKey } from '../domain/equation.ts';
import { isUlid } from '../domain/ids.ts';
import type { Player, Sign } from '../domain/types.ts';
import { REORDERED, YOURS, solveSign } from '../posting/posting.ts';
import { badgesFrom, credits, draw, loadQuiz, onSigns, solvedBy, stillToTry, type OnSign, type Solve } from './data.ts';
import {
  AllDonePage,
  CodePage,
  DeletePage,
  FoundPage,
  HomePage,
  LinkPage,
  MessagePage,
  NamePage,
  ProfilePage,
  RemovePhotoPage,
  SignInPage,
  SolvePage,
  SolvedPage,
  WaysPage,
  type Here,
  type ProfileDone,
  type ProfileTrouble,
  type Said
} from './pages.tsx';
import { forget, fromQuiz, quizViewer, remember } from './session.ts';
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
// `to` is a sign's id, or an old slug, whose address goes on to the id's.
const onward = (to: string | undefined) => (to ? signPath({ id: to }) : '/next');

export function createQuiz(options: QuizOptions): Hono {
  const quiz = new Hono();
  if (!(options.quizOpen ?? QUIZ_OPEN)) {
    quiz.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, NO_STORE));
    quiz.all('*', (c) => c.html(soon(options.urls.site), 200, NO_STORE));
    return quiz;
  }

  const { store, urls, mailer, clientIp } = options;
  const here: Here = { site: urls.site, quiz: urls.quiz ?? quizOrigin(urls.site) };
  const page = (
    c: Context,
    body: { toString(): string },
    status: 200 | 400 | 404 | 409 | 413 | 422 | 429 | 503 = 200
  ) => c.html('<!doctype html>' + body.toString(), status, PRIVATE);
  const go = (c: Context, path: string) => c.redirect(path, 303);
  const form = async (c: Context) => {
    const body = await c.req.parseBody();
    return (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
  };

  /** The signed-in player, or a redirect: to sign in, or to give a name first, then back to `to`. */
  async function playing(c: Context, to?: string): Promise<Viewer | Response> {
    const viewer = await quizViewer(store, c);
    if (!viewer) return go(c, withTo('/signin', to));
    if (!viewer.player.name) return go(c, withTo('/name', to));
    return viewer;
  }

  quiz.use('*', async (c, next) => {
    if (c.req.method === 'POST' && !fromQuiz(c, here.quiz)) {
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
    if (await quizViewer(store, c)) return go(c, '/next');
    const data = await loadQuiz(store, undefined);
    const withPhoto = data.signs.filter((s) => s.photos.length && s.numbers.length);
    return page(c, <HomePage here={here} sample={withPhoto[0]} more={withPhoto.slice(1, 4)} />);
  });

  // ---- Signing in

  quiz.get('/signin', async (c) => {
    const loginId = c.req.query('l');
    const token = c.req.query('t');
    const to = backTo(c.req.query('to'));
    if (loginId && token) return page(c, <LinkPage here={here} loginId={loginId} token={token} to={to} />);
    if (await quizViewer(store, c)) return go(c, onward(to));
    return page(c, <SignInPage here={here} to={to} />);
  });

  quiz.post('/signin', async (c) => {
    const field = await form(c);
    const email = field('email').trim();
    const to = backTo(field('to'));
    const link = (loginId: string, token: string) =>
      `${here.quiz}/signin?l=${encodeURIComponent(loginId)}&t=${encodeURIComponent(token)}${to ? `&to=${to}` : ''}`;
    try {
      const started = await startSignIn({ store, mailer, link, front: 'quiz' }, email, clientIp(c));
      return page(
        c,
        <CodePage here={here} loginId={started.loginId} email={email} sent={field('again') === '1'} to={to} />
      );
    } catch (err) {
      if (!(err instanceof ApiError) || (err.code !== 'bad_request' && err.code !== 'rate_limited')) throw err;
      const message = err.code === 'bad_request' ? 'That doesn’t look like an email address.' : err.message;
      return page(
        c,
        <SignInPage here={here} email={email} error={message} to={to} />,
        err.code === 'bad_request' ? 400 : 429
      );
    }
  });

  /** Signs in with the code or the link's token, then on to a name or the signs (the one in `to`). */
  async function finish(c: Context, input: { loginId: string; code?: string; token?: string }, to?: string) {
    const done = await finishSignIn(store, input, 'quiz');
    // A new player joins the newsletter, as in the app (Jamie, 2026-11-07), tagged `quiz`.
    await newsletterAtSignIn({ store, newsletter: options.newsletter }, done, 'quiz');
    remember(c, done.token);
    return go(c, done.player.name ? onward(to) : withTo('/name', to));
  }

  quiz.post('/signin/code', async (c) => {
    const field = await form(c);
    const email = field('email');
    const loginId = field('login');
    const to = backTo(field('to'));
    try {
      return await finish(c, { loginId, code: field('code').trim() }, to);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code === 'internal' || err.code === 'unavailable') throw err;
      return page(c, <CodePage here={here} loginId={loginId} email={email} error={codeTrouble(err)} to={to} />, 400);
    }
  });

  quiz.post('/signin/link', async (c) => {
    const field = await form(c);
    try {
      return await finish(c, { loginId: field('login'), token: field('token') }, backTo(field('to')));
    } catch (err) {
      if (!(err instanceof ApiError) || err.code === 'internal' || err.code === 'unavailable') throw err;
      return page(
        c,
        <MessagePage
          here={here}
          title="That link has ended"
          message="Sign-in links work once, for 15 minutes. Sign in again and we’ll send a new one."
        />,
        400
      );
    }
  });

  quiz.get('/name', async (c) => {
    const viewer = await quizViewer(store, c);
    const to = backTo(c.req.query('to'));
    if (!viewer) return go(c, withTo('/signin', to));
    if (viewer.player.name) return go(c, onward(to));
    return page(c, <NamePage here={here} player={viewer.player} to={to} />);
  });

  quiz.post('/name', async (c) => {
    const viewer = await quizViewer(store, c);
    if (!viewer) return go(c, '/signin');
    const field = await form(c);
    const to = backTo(field('to'));
    try {
      await updateMe(store, viewer.player, { name: field('name') });
    } catch (err) {
      if (!(err instanceof ApiError) || (err.code !== 'bad_request' && err.code !== 'rate_limited')) throw err;
      return page(
        c,
        <NamePage here={here} player={viewer.player} error={err.message.replace(/([^.])$/, '$1.')} to={to} />,
        400
      );
    }
    return go(c, onward(to));
  });

  quiz.post('/signout', async (c) => {
    const viewer = await quizViewer(store, c);
    if (viewer) await signOut(store, viewer);
    forget(c);
    return go(c, '/');
  });

  // ---- Playing

  quiz.get('/next', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const data = await loadQuiz(store, viewer.player);
    const left = stillToTry(data, await onSigns(store, data.signs), viewer.player.id);
    const sign = draw(left, c.req.query('after'));
    if (!sign) return page(c, <AllDonePage here={here} player={viewer.player} />);
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

  /** A shown sign the player sees, by id (or a slug, from a page drawn before ids), with its ways
   * and co-finds, or a not-found page. */
  async function signFor(c: Context, player: Player) {
    const data = await loadQuiz(store, player);
    const sign = signByKey(data.signs, c.req.param('key') ?? '')?.found;
    if (!sign)
      return {
        missing: page(
          c,
          <MessagePage
            here={here}
            player={player}
            title="No sign here"
            message="That sign isn’t in Quiz. There are others to try."
          />,
          404
        )
      };
    const [ways, coFinds] = await Promise.all([store.listWays(sign.id), store.listCoFinds(sign.id)]);
    // A blocked player's ways are left out, as the API leaves them for this reader.
    const on: OnSign = { ways: ways.filter((w) => !data.blocked.has(w.playerId)), coFinds };
    return { data, sign, on };
  }

  const solvePage = (
    c: Context,
    player: Player,
    sign: Sign,
    on: OnSign,
    data: Awaited<ReturnType<typeof loadQuiz>>,
    said?: Said,
    status: 200 | 400 | 409 | 429 = 200
  ) => page(c, <SolvePage here={here} player={player} sign={sign} on={on} people={data.people} said={said} />, status);

  quiz.get('/signs/:key', async (c) => {
    const old = await moved(c);
    if (old) return old;
    const viewer = await playing(c, backTo(c.req.param('key') ?? ''));
    if (viewer instanceof Response) return viewer;
    const got = await signFor(c, viewer.player);
    if (got.missing) return got.missing;
    return solvePage(c, viewer.player, got.sign, got.on, got.data);
  });

  quiz.post('/signs/:key/solve', async (c) => {
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
      if (err.code === 'conflict' && err.message === REORDERED) {
        const key = sameWayKey(text);
        const way = on.ways.find((w) => sameWayKey(w.text) === key);
        if (way) {
          const said: Said = { kind: 'reordered', tried: text, way, by: data.people.get(way.playerId) };
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
    const viewer = await playing(c);
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
    const viewer = await playing(c);
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
    return page(c, <SolvedPage here={here} player={viewer.player} solved={solved} now={new Date()} />);
  });

  // ---- Your profile: photo, name and bio, sign out, and Delete my account, as the app's settings

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

  async function profilePage(
    c: Context,
    player: Player,
    more: { done?: ProfileDone; trouble?: ProfileTrouble; typed?: { name: string; bio: string } } = {},
    status: Parameters<typeof page>[2] = 200
  ) {
    const { hasPage } = await profileOf(player);
    return page(c, <ProfilePage here={here} player={player} hasPage={hasPage} {...more} />, status);
  }

  quiz.get('/profile', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const done = c.req.query('done');
    return profilePage(c, viewer.player, { done: done && done in DONE_WORDS ? (done as ProfileDone) : undefined });
  });

  quiz.post('/profile', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const field = await form(c);
    const typed = { name: field('name'), bio: field('bio') };
    try {
      await updateMe(store, viewer.player, typed);
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited']);
      const message = sentence((err as ApiError).message);
      return profilePage(c, viewer.player, { trouble: { part: 'about', message }, typed }, status);
    }
    return go(c, '/profile?done=saved');
  });

  quiz.post('/profile/photo', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    try {
      // The form's own bytes are a little over the photo's; anything far bigger isn't read.
      const length = Number(c.req.header('content-length'));
      if (length > LIMITS.photoBytes + 64 * 1024)
        fail('too_large', `A photo can be at most ${LIMITS.photoBytes / 1024 / 1024} MB`);
      const photo = (await c.req.parseBody()).photo;
      if (!(photo instanceof File) || !photo.size) return fail('bad_request', 'Choose a photo first');
      // The same as the app's PUT /me/avatar: checked, squared, without its metadata, and looked at by the moderator.
      await setAvatar(options, viewer.player, photo.type, () => photo.arrayBuffer(), photo.size);
    } catch (err) {
      const status = trouble(err, ['bad_request', 'too_large', 'refused', 'rate_limited', 'conflict', 'unavailable']);
      const message = sentence((err as ApiError).message);
      return profilePage(c, viewer.player, { trouble: { part: 'photo', message } }, status);
    }
    return go(c, '/profile?done=photo');
  });

  quiz.get('/profile/photo/remove', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    if (!viewer.player.avatar) return go(c, '/profile');
    return page(c, <RemovePhotoPage here={here} player={viewer.player} />);
  });

  quiz.post('/profile/photo/remove', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    try {
      await removeAvatar(options, viewer.player);
    } catch (err) {
      const status = trouble(err, ['conflict']);
      return page(
        c,
        <RemovePhotoPage here={here} player={viewer.player} error={sentence((err as ApiError).message)} />,
        status
      );
    }
    return go(c, '/profile?done=removed');
  });

  quiz.get('/profile/delete', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    const { posted } = await profileOf(viewer.player);
    return page(c, <DeletePage here={here} player={viewer.player} posted={posted} />);
  });

  quiz.post('/profile/delete', async (c) => {
    const viewer = await playing(c);
    if (viewer instanceof Response) return viewer;
    try {
      // The same code as DELETE /me: everything the account made goes, then the newsletter.
      await removePlayer(options, viewer.player);
    } catch (err) {
      const status = trouble(err, ['conflict', 'unavailable']);
      const { posted } = await profileOf(viewer.player);
      const error = sentence((err as ApiError).message);
      return page(c, <DeletePage here={here} player={viewer.player} posted={posted} error={error} />, status);
    }
    forget(c);
    return go(c, '/deleted');
  });

  quiz.get('/deleted', async (c) => {
    if (await quizViewer(store, c)) return go(c, '/profile');
    return page(
      c,
      <MessagePage
        here={here}
        title="Your account is deleted"
        message="It’s gone, with everything it made, here and in the app. Thanks for playing Road Sign Math."
      />
    );
  });

  quiz.notFound((c) =>
    page(c, <MessagePage here={here} title="Nothing here" message="That page isn’t part of Quiz." />, 404)
  );

  quiz.onError((err, c) => {
    if (err instanceof ApiError && err.code === 'unauthorized') {
      forget(c);
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

const DONE_WORDS: Record<ProfileDone, true> = { photo: true, removed: true, saved: true };

/**
 * The status for an error a profile form shows on its page, when it is one of `shown`; anything
 * else (a gone account, a broken server) is thrown on to Quiz's error handler.
 */
function trouble(err: unknown, shown: ApiError['code'][]): 200 | 400 | 409 | 413 | 422 | 429 | 503 {
  if (!(err instanceof ApiError) || !shown.includes(err.code)) throw err;
  return STATUS[err.code] as 400 | 409 | 413 | 422 | 429 | 503;
}

/** A server message as a sentence: a capital first, a full stop last. */
const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1).replace(/([^.!?])$/, '$1.');

/** What went wrong with a code, in words for the code page. */
function codeTrouble(err: ApiError): string {
  if (err.code === 'rate_limited') return 'Too many tries. Sign in again for a new code.';
  if (err.code === 'bad_request') return 'Type the 6-digit code from the email.';
  return 'That code didn’t work. Check the newest email, or send it again.';
}

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
