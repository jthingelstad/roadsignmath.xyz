// Signing in and the profile on the web, one flow for Quiz (src/quiz/quiz.tsx) and the site's
// signed-in side (src/web/account.tsx): sign in by email (a code, or the email's link, whose page
// changes nothing until its button posts, so a mail scanner can't use it up), the name step, sign
// out, and the profile (photo, name, bio, website, home, Delete my account), through the same
// account code as the app's (`updateMe`, `setAvatar`, `removeAvatar`, `removePlayer`). Each front
// gives its paths and words (`Here.front`, `pathsOf` in pages.tsx), its cookies (`Jar`) and, for
// Quiz, the math a signed-out player carries through signing in. No GET changes anything; the
// caller checks every POST's Origin first.

import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { LIMITS } from '../api/contract.ts';
import { ApiError, STATUS, fail } from '../api/errors.ts';
import { newsletterAtSignIn, removeAvatar, removePlayer, setAvatar, updateMe } from '../auth/account.ts';
import { finishSignIn, signOut, startSignIn, type Viewer } from '../auth/auth.ts';
import type { Player } from '../domain/types.ts';
import {
  CodePage,
  DeletePage,
  LinkPage,
  MessagePage,
  NamePage,
  ProfilePage,
  RemovePhotoPage,
  SignInPage,
  pathsOf,
  withAt,
  type Here,
  type ProfileDone,
  type ProfileTrouble
} from './pages.tsx';
import { forget, freshMarker, remember, sessionViewer, type Jar } from './session.ts';

export type Status = 200 | 400 | 404 | 409 | 413 | 422 | 429 | 503;

export type AccountFront = {
  options: ApiOptions & { clientIp: (c: Context) => string };
  here: Here;
  jar: Jar;
  /** Draws a page as the front's answer (never cached). */
  page: (c: Context, body: Child, status?: Status) => Promise<Response>;
  /** The sign to land on after signing in, checked, or undefined. */
  backTo: (raw: string | undefined) => string | undefined;
  /** Where a signed-in player goes on: the sign in `to`, or the front's own start. */
  onward: (to: string | undefined) => string;
  /** Math a signed-out Quiz player built, carried through signing in (Quiz only). */
  carry?: {
    /** The math in a form, checked against the sign named `to`, or undefined. */
    fromForm: (to: string, raw: string) => Promise<string | undefined>;
    /** Where carried math lands once they are in (drawn, never in an address). */
    land: (c: Context, player: Player, to: string, raw: string) => Promise<Response>;
  };
  /** Whether the site has a page for the player yet, and how many signs they posted. */
  profileOf: (player: Player) => Promise<{ hasPage: boolean; posted: number }>;
  /** The sign in play (`?at=`) the profile carries, Quiz only. */
  at?: (c: Context) => string | undefined;
  /** What the profile shows in place of the link to the signs you've solved (the site's list). */
  yours?: (player: Player) => Promise<Child>;
  /** Where Delete my account lands. */
  deletedWords: string;
};

const DONE_WORDS: Record<ProfileDone, true> = { photo: true, removed: true, saved: true, deleted: true };

/**
 * The status for an error a form shows on its page, when it is one of `shown`; anything else (a
 * gone account, a broken server) is thrown on to the front's error handler.
 */
export function trouble(err: unknown, shown: ApiError['code'][]): Status {
  if (!(err instanceof ApiError) || !shown.includes(err.code)) throw err;
  return STATUS[err.code] as Status;
}

/** A server message as a sentence: a capital first, a full stop last. */
export const sentence = (message: string) =>
  message.charAt(0).toUpperCase() + message.slice(1).replace(/([^.!?])$/, '$1.');

/** What went wrong with a code, in words for the code page (`said=` on its address). */
const CODE_TROUBLE = {
  tries: 'Too many tries. Sign in again for a new code.',
  format: 'Type the 6-digit code from the email.',
  wrong: 'That code didn’t work. Check the newest email, or send it again.'
} as const;

/** What the code page says after a send: another email went, or what went wrong with a code. */
type CodeSaid = 'sent' | keyof typeof CODE_TROUBLE;

function codeTrouble(err: ApiError): CodeSaid {
  if (err.code === 'rate_limited') return 'tries';
  if (err.code === 'bad_request') return 'format';
  return 'wrong';
}

const withTo = (path: string, to: string | undefined) => (to ? `${path}?to=${encodeURIComponent(to)}` : path);

/** Mounts the sign-in and profile pages on a front, at its paths. */
export function mountAccount(app: Hono, front: AccountFront): void {
  const { options, here, jar, page, backTo, onward, carry } = front;
  const { store, mailer, clientIp } = options;
  const paths = pathsOf(here);
  const go = (c: Context, path: string) => c.redirect(path, 303);
  const form = async (c: Context) => {
    const body = await c.req.parseBody();
    return (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
  };
  const viewerOf = (c: Context) => sessionViewer(store, c, jar);
  const at = (c: Context) => front.at?.(c);
  const codePath = (loginId: string, to: string | undefined, said?: CodeSaid) =>
    `${paths.code}?l=${encodeURIComponent(loginId)}${to ? `&to=${encodeURIComponent(to)}` : ''}${said ? `&said=${said}` : ''}`;
  /** The origin the email's link opens: the front's own. */
  const origin = here.front === 'site' ? here.site : here.quiz;
  const mailFront = here.front === 'site' ? 'site' : 'quiz';

  /** The signed-in player, or a redirect: to sign in, or to give a name first, then back to `to`. */
  async function signedIn(c: Context, to?: string): Promise<Viewer | Response> {
    const viewer = await viewerOf(c);
    if (!viewer) return go(c, withTo(paths.signin, to));
    if (!viewer.player.name) return go(c, withTo(paths.name, to));
    return viewer;
  }

  // ---- Signing in

  /** The sign-in page, or for Quiz (whose email's link lands on `/signin`) the link's page. */
  app.get(paths.signin, async (c, next) => {
    const loginId = c.req.query('l');
    const token = c.req.query('t');
    const to = backTo(c.req.query('to'));
    if (loginId && token) {
      // The site's `/signin` with a link's token is the iPhone app's (src/web/site.tsx), unchanged.
      if (paths.link !== paths.signin && here.front === 'site') return next();
      return page(c, <LinkPage here={here} loginId={loginId} token={token} to={to} />);
    }
    if (await viewerOf(c)) return go(c, onward(to));
    return page(c, <SignInPage here={here} to={to} />);
  });

  if (here.front === 'site') {
    app.get(paths.link, async (c) => {
      const loginId = c.req.query('l');
      const token = c.req.query('t');
      // `to` goes through the same allowlist as everywhere else, so the link lands back on the
      // posting form or a report form it was started from.
      const to = backTo(c.req.query('to'));
      if (!loginId || !token) return go(c, withTo(paths.signin, to));
      return page(c, <LinkPage here={here} loginId={loginId} token={token} to={to} />);
    });
  }

  app.post(paths.signin, async (c) => {
    const field = await form(c);
    const to = backTo(field('to'));
    // "Send the email again" names the sign-in it follows, whose row holds the address.
    const again = field('again') === '1' && field('login') ? await store.getLogin(field('login')) : undefined;
    if (field('again') === '1' && field('login') && !again) return go(c, withTo(paths.signin, to));
    const email = again?.email ?? field('email').trim();
    // The math they built on the sign, kept on the sign-in's row (never in a URL), so the code page,
    // the email's link and the name page can all bring it back. "Send the email again" keeps it.
    const math = carry && to && field('math') ? await carry.fromForm(to, field('math')) : undefined;
    const carried = again ? again.carry : to && math ? { to, text: math } : undefined;
    const landing = here.front === 'site' ? paths.link : paths.signin;
    const link = (loginId: string, token: string) =>
      `${origin}${landing}?l=${encodeURIComponent(loginId)}&t=${encodeURIComponent(token)}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    try {
      const started = await startSignIn({ store, mailer, link, front: mailFront, carry: carried }, email, clientIp(c));
      // The code page is a page of its own, so a refresh shows it again instead of sending another email.
      return go(c, codePath(started.loginId, to, again ? 'sent' : undefined));
    } catch (err) {
      if (!(err instanceof ApiError) || (err.code !== 'bad_request' && err.code !== 'rate_limited')) throw err;
      const message = err.code === 'bad_request' ? 'That doesn’t look like an email address.' : err.message;
      // A resend that hit a limit keeps the math its sign-in row carries, for the next try.
      const kept = math ?? (to && again?.carry?.to === to ? again.carry.text : undefined);
      return page(
        c,
        <SignInPage
          here={here}
          email={email}
          error={message}
          badEmail={err.code === 'bad_request'}
          to={to}
          math={kept}
        />,
        err.code === 'bad_request' ? 400 : 429
      );
    }
  });

  /**
   * The code page, by the sign-in's id: the address comes from its row, never the URL. A sign-in
   * that has ended (used, too many wrong codes, or past its 15 minutes) goes back to the email page.
   */
  app.get(paths.code, async (c) => {
    const to = backTo(c.req.query('to'));
    const loginId = c.req.query('l') ?? '';
    const said = c.req.query('said');
    const login = loginId ? await store.getLogin(loginId) : undefined;
    if (!login) {
      const ended = said === 'tries' ? CODE_TROUBLE.tries : 'That sign-in has ended. Sign in again for a new code.';
      return page(c, <SignInPage here={here} error={ended} to={to} />);
    }
    const error = said && said in CODE_TROUBLE ? CODE_TROUBLE[said as keyof typeof CODE_TROUBLE] : undefined;
    const math = login.carry && login.carry.to === to ? login.carry.text : undefined;
    return page(
      c,
      <CodePage
        here={here}
        loginId={login.id}
        email={login.email}
        sent={said === 'sent'}
        error={error}
        to={to}
        math={math}
      />
    );
  });

  /**
   * Signs in with the code or the link's token, then on to a name or onward (the sign in `to`).
   * Math carried on the sign-in's row comes back on that sign.
   */
  async function finish(c: Context, input: { loginId: string; code?: string; token?: string }, to?: string) {
    // Read before signing in uses the row up. A wrong code leaves it, math and all.
    const login = input.loginId ? await store.getLogin(input.loginId) : undefined;
    const done = await finishSignIn(store, input, mailFront);
    // A new player joins the newsletter, as in the app (Jamie, 2026-11-07).
    await newsletterAtSignIn({ store, newsletter: options.newsletter }, done, mailFront);
    remember(c, jar, done.token, done.player);
    const carried = carry && to && login?.carry?.to === to ? login.carry.text : undefined;
    if (carried) return carry!.land(c, done.player, to!, carried);
    return go(c, done.player.name ? onward(to) : withTo(paths.name, to));
  }

  app.post(paths.code, async (c) => {
    const field = await form(c);
    const loginId = field('login');
    const to = backTo(field('to'));
    try {
      return await finish(c, { loginId, code: field('code').trim() }, to);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code === 'internal' || err.code === 'unavailable') throw err;
      return go(c, codePath(loginId, to, codeTrouble(err)));
    }
  });

  app.post(paths.link, async (c) => {
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
          action={here.front === 'site' ? { href: paths.signin, label: 'Sign in again' } : undefined}
        />,
        400
      );
    }
  });

  app.get(paths.name, async (c) => {
    const viewer = await viewerOf(c);
    const to = backTo(c.req.query('to'));
    if (!viewer) return go(c, withTo(paths.signin, to));
    if (viewer.player.name) return go(c, onward(to));
    return page(c, <NamePage here={here} player={viewer.player} to={to} />);
  });

  app.post(paths.name, async (c) => {
    const viewer = await viewerOf(c);
    if (!viewer) return go(c, paths.signin);
    const field = await form(c);
    const to = backTo(field('to'));
    const math = carry && to && field('math') ? await carry.fromForm(to, field('math')) : undefined;
    let named: Player;
    try {
      // The same check as the app's: the moderator looks at the name first.
      named = await updateMe(options, viewer.player, { name: field('name') });
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited', 'refused', 'unavailable']);
      return page(
        c,
        <NamePage
          here={here}
          player={viewer.player}
          error={(err as ApiError).message.replace(/([^.])$/, '$1.')}
          to={to}
          math={math}
        />,
        status === 400 || status === 429 ? 400 : status
      );
    }
    freshMarker(c, jar, named);
    if (carry && to && math) return carry.land(c, named, to, math);
    return go(c, onward(to));
  });

  app.post(paths.signout, async (c) => {
    const viewer = await viewerOf(c);
    if (viewer) await signOut(store, viewer);
    forget(c, jar);
    return go(c, '/');
  });

  // ---- The profile: photo, name, bio, website and home, sign out, and Delete my account

  async function profilePage(
    c: Context,
    player: Player,
    more: {
      done?: ProfileDone;
      trouble?: ProfileTrouble;
      typed?: { name: string; bio: string; website: string; home: string };
    } = {},
    status: Status = 200
  ) {
    const { hasPage } = await front.profileOf(player);
    const yours = front.yours ? await front.yours(player) : undefined;
    return page(
      c,
      <ProfilePage here={here} player={player} hasPage={hasPage} at={at(c)} yours={yours} {...more} />,
      status
    );
  }

  app.get(paths.profile, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    const done = c.req.query('done');
    return profilePage(c, viewer.player, { done: done && done in DONE_WORDS ? (done as ProfileDone) : undefined });
  });

  app.post(paths.profile, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    const field = await form(c);
    const typed = { name: field('name'), bio: field('bio'), website: field('website'), home: field('home') };
    try {
      freshMarker(c, jar, await updateMe(options, viewer.player, typed));
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited', 'refused', 'unavailable']);
      const message = sentence((err as ApiError).message);
      return profilePage(c, viewer.player, { trouble: { part: 'about', message }, typed }, status);
    }
    return go(c, withAt(`${paths.profile}?done=saved`, at(c)));
  });

  app.post(paths.photo, async (c) => {
    const viewer = await signedIn(c);
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
      const now = await store.getPlayer(viewer.player.id);
      if (now) freshMarker(c, jar, now);
    } catch (err) {
      const status = trouble(err, ['bad_request', 'too_large', 'refused', 'rate_limited', 'conflict', 'unavailable']);
      const message = sentence((err as ApiError).message);
      return profilePage(c, viewer.player, { trouble: { part: 'photo', message } }, status);
    }
    return go(c, withAt(`${paths.profile}?done=photo`, at(c)));
  });

  app.get(paths.photoRemove, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    if (!viewer.player.avatar) return go(c, withAt(paths.profile, at(c)));
    return page(c, <RemovePhotoPage here={here} player={viewer.player} at={at(c)} />);
  });

  app.post(paths.photoRemove, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    try {
      await removeAvatar(options, viewer.player);
      freshMarker(c, jar, { ...viewer.player, avatar: undefined });
    } catch (err) {
      const status = trouble(err, ['conflict']);
      return page(
        c,
        <RemovePhotoPage here={here} player={viewer.player} error={sentence((err as ApiError).message)} at={at(c)} />,
        status
      );
    }
    return go(c, withAt(`${paths.profile}?done=removed`, at(c)));
  });

  app.get(paths.del, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    const { posted } = await front.profileOf(viewer.player);
    return page(c, <DeletePage here={here} player={viewer.player} posted={posted} at={at(c)} />);
  });

  app.post(paths.del, async (c) => {
    const viewer = await signedIn(c);
    if (viewer instanceof Response) return viewer;
    try {
      // The same code as DELETE /me: everything the account made goes, then the newsletter.
      await removePlayer(options, viewer.player);
    } catch (err) {
      const status = trouble(err, ['conflict', 'unavailable']);
      const { posted } = await front.profileOf(viewer.player);
      const error = sentence((err as ApiError).message);
      return page(
        c,
        <DeletePage here={here} player={viewer.player} posted={posted} error={error} at={at(c)} />,
        status
      );
    }
    forget(c, jar);
    return go(c, paths.deleted);
  });

  app.get(paths.deleted, async (c) => {
    if (await viewerOf(c)) return go(c, paths.profile);
    return page(c, <MessagePage here={here} title="Your account is deleted" message={front.deletedWords} />);
  });
}
