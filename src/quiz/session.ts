// Quiz's sign-in lives in a cookie, `rsm_quiz`, holding the same token the app keeps
// (`rsm_<playerId>_<secret>`, src/auth/auth.ts): one player, one account, any number of signed-in
// devices. The cookie is HttpOnly and Secure, so no script reads it and it never travels over
// plain HTTP. It is SameSite=Lax rather than Strict so a player who follows a link to Quiz from
// another site arrives signed in; no GET changes anything, and every POST must come from Quiz's
// own pages (`fromQuiz`, the Origin header), which stops another site's form from acting for them.

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ApiError } from '../api/errors.ts';
import { SESSION_IDLE, viewerFor, type Viewer } from '../auth/auth.ts';
import { nowSeconds, type Store } from '../store/store.ts';

export const COOKIE = 'rsm_quiz';

const OPTIONS = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' } as const;

/**
 * The signed-in player, or undefined. A cookie whose token has ended is cleared. One that works is
 * sent again to last as long as its session now does: the session is pushed back as it is used
 * (`viewerFor`), and the browser's copy would otherwise end first, at 180 days from sign-in.
 */
export async function quizViewer(store: Store, c: Context): Promise<Viewer | undefined> {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  try {
    const viewer = await viewerFor(store, `Bearer ${token}`);
    if (viewer) {
      const left = Math.min(SESSION_IDLE, viewer.session.expiresAt - nowSeconds());
      if (left > 0) setCookie(c, COOKIE, token, { ...OPTIONS, maxAge: left });
    }
    return viewer;
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'unauthorized') throw err;
    forget(c);
    return undefined;
  }
}

/** Keeps a new token for as long as a session lasts unused (it is pushed back as it is used). */
export function remember(c: Context, token: string): void {
  setCookie(c, COOKIE, token, { ...OPTIONS, maxAge: SESSION_IDLE });
}

export function forget(c: Context): void {
  deleteCookie(c, COOKIE, OPTIONS);
}

/** Whether a POST came from one of Quiz's own pages. */
export const fromQuiz = (c: Context, origin: string): boolean => c.req.header('origin') === origin;
