// The sign-in on the web, shared by Quiz and the site's signed-in side (src/web/account.tsx). A
// cookie holds the same token the app keeps (`rsm_<playerId>_<secret>`, src/auth/auth.ts): one
// player, one account, any number of signed-in devices. The cookie is HttpOnly and Secure, so no
// script reads it and it never travels over plain HTTP. It is SameSite=Lax rather than Strict so a
// player who follows a link from another site arrives signed in; no GET changes anything, and every
// POST must come from the front's own pages (`fromOrigin`, the Origin header), which stops another
// site's form from acting for them.
//
// Two cookies, by whether the site's sign-in is open (`SITE_SIGNIN_OPEN`, src/web/account.tsx):
//
// - Shut, as Quiz has always been: `rsm_quiz`, on quiz.<domain> only.
// - Open (D5a, one sign-in for both): `rsm_session`, for <domain> and every name under it, so
//   signing in on the site or in Quiz signs you in on both. Quiz's `rsm_quiz` is still read until
//   it expires; once read it moves to `rsm_session`. Beside it goes `rsm_me`, a marker that holds
//   no secret (the face's colour, photo id and first letter), which the site's cached pages read
//   with a small script to put the player's face where "Sign in" is, so no page is cached per person.
//
// Either cookie is read whatever the switch says, so a sign-in made while it was open still works
// if it is shut again.

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ApiError } from '../api/errors.ts';
import { SESSION_IDLE, viewerFor, type Viewer } from '../auth/auth.ts';
import type { Player } from '../domain/types.ts';
import { nowSeconds, type Store } from '../store/store.ts';

/** Quiz's own cookie, on quiz.<domain> only: the one Quiz sets while the site's sign-in is shut. */
export const COOKIE = 'rsm_quiz';
/** The shared cookie, for <domain> and its names, while the site's sign-in is open. */
export const SESSION_COOKIE = 'rsm_session';
/** The marker the site's pages read for the header's face. Holds no secret; scripts may read it. */
export const MARKER_COOKIE = 'rsm_me';

const OPTIONS = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' } as const;

/**
 * Which cookies a front writes: `shared` while the site's sign-in is open, and the domain the
 * shared ones are for (none on localhost, where cookies already cross ports).
 */
export type Jar = { shared: boolean; domain?: string };

/** The domain the shared cookies are for: the site's host, or none for localhost and addresses. */
export function cookieDomain(site: string): string | undefined {
  const host = new URL(site).hostname;
  return host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') ? undefined : host;
}

export const jarFor = (site: string, shared: boolean): Jar => ({ shared, domain: cookieDomain(site) });

const sharedOptions = (jar: Jar) => ({ ...OPTIONS, ...(jar.domain && { domain: jar.domain }) });

/**
 * The marker's value: `1.<colour>.<photo id>.<letter>`, each part checked again by the script that
 * reads it. The letter is the face's, the first character of the name in capitals as `Face` draws
 * it (`ß` is `SS`), percent-encoded with its dots too, so no name can add a part or leave the
 * script without one. Nothing in it is private: all of it is on the player's public page.
 */
export function markerOf(player: Pick<Player, 'name' | 'avatarColor' | 'avatar'>): string {
  const color = /^#[0-9A-Fa-f]{6}$/.test(player.avatarColor) ? player.avatarColor.slice(1) : '006348';
  const photo = player.avatar && /^[\w-]+$/.test(player.avatar) ? player.avatar : '';
  return `1.${color}.${photo}.${encodeURIComponent(faceLetter(player.name)).replace(/\./g, '%2E')}`;
}

/** The letter a face without a photo shows: the name's first character in capitals, or `?`. */
export const faceLetter = (name: string): string => [...(name.trim() || '?')][0]!.toUpperCase();

function keep(c: Context, jar: Jar, token: string, player: Player, maxAge: number): void {
  if (!jar.shared) {
    setCookie(c, COOKIE, token, { ...OPTIONS, maxAge });
    return;
  }
  setCookie(c, SESSION_COOKIE, token, { ...sharedOptions(jar), maxAge });
  setCookie(c, MARKER_COOKIE, markerOf(player), { ...sharedOptions(jar), httpOnly: false, maxAge });
}

/**
 * The signed-in player, or undefined. A cookie whose token has ended is cleared. One that works is
 * sent again to last as long as its session now does: the session is pushed back as it is used
 * (`viewerFor`), and the browser's copy would otherwise end first, at 180 days from sign-in. While
 * the shared cookie is on, Quiz's own moves to it, and the marker is sent again with today's face.
 */
export function sessionViewer(store: Store, c: Context, jar: Jar): Promise<Viewer | undefined> {
  // Once a request: a handler and the page it draws ask the same question, and the cookies it
  // sends again go out once.
  let viewer = viewers.get(c);
  if (!viewer) {
    viewer = readViewer(store, c, jar);
    viewers.set(c, viewer);
  }
  return viewer;
}

/** Each request's answer to `sessionViewer`, until it signs in or out (`remember`, `forget`). */
const viewers = new WeakMap<Context, Promise<Viewer | undefined>>();

async function readViewer(store: Store, c: Context, jar: Jar): Promise<Viewer | undefined> {
  const shared = getCookie(c, SESSION_COOKIE);
  const own = getCookie(c, COOKIE);
  const token = shared ?? own;
  if (!token) return undefined;
  try {
    const viewer = await viewerFor(store, `Bearer ${token}`);
    if (viewer) {
      const left = Math.min(SESSION_IDLE, viewer.session.expiresAt - nowSeconds());
      if (left > 0) {
        if (shared) {
          // A shared cookie is kept shared, even with the switch shut again.
          setCookie(c, SESSION_COOKIE, shared, { ...sharedOptions(jar), maxAge: left });
          if (jar.shared) {
            setCookie(c, MARKER_COOKIE, markerOf(viewer.player), {
              ...sharedOptions(jar),
              httpOnly: false,
              maxAge: left
            });
          }
        } else {
          keep(c, jar, token, viewer.player, left);
        }
      }
      // Quiz's own cookie, moved to the shared one (or left behind for it), goes.
      if (own && (shared || jar.shared)) deleteCookie(c, COOKIE, OPTIONS);
    }
    return viewer;
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'unauthorized') throw err;
    forget(c, jar);
    return undefined;
  }
}

/** Keeps a new token for as long as a session lasts unused (it is pushed back as it is used). */
export function remember(c: Context, jar: Jar, token: string, player: Player): void {
  viewers.delete(c);
  keep(c, jar, token, player, SESSION_IDLE);
}

/**
 * Sends the marker again after the face changed (a new name or photo), while the shared cookie is on.
 */
export function freshMarker(c: Context, jar: Jar, player: Player): void {
  if (!jar.shared || !getCookie(c, SESSION_COOKIE)) return;
  setCookie(c, MARKER_COOKIE, markerOf(player), { ...sharedOptions(jar), httpOnly: false, maxAge: SESSION_IDLE });
}

/** Signs this browser out: Quiz's own cookie as always, and the shared ones when it has them. */
export function forget(c: Context, jar: Jar): void {
  viewers.set(c, Promise.resolve(undefined));
  deleteCookie(c, COOKIE, OPTIONS);
  if (jar.shared || getCookie(c, SESSION_COOKIE) !== undefined || getCookie(c, MARKER_COOKIE) !== undefined) {
    deleteCookie(c, SESSION_COOKIE, sharedOptions(jar));
    deleteCookie(c, MARKER_COOKIE, { ...sharedOptions(jar), httpOnly: false });
  }
}

/** Whether a POST came from one of the front's own pages. */
export const fromOrigin = (c: Context, origin: string): boolean => c.req.header('origin') === origin;
