// Pages are addressed by name: a sign at /signs/<slug> and a player at /players/<handle>. A
// sign's slug comes from its title when it is posted and a handle from a player's first name,
// and neither ever changes, so these addresses last. From 12 to 13 November 2026 the pages were
// addressed by id (/signs/<id>, /players/<id>); Jamie then chose the names again ("Approved: make
// the name addresses canonical again for signs and players, with id links redirecting to them").
// An id, in any case, goes to the name's address with a 301 that keeps the query string, so the
// links shared in those days still land. A slug or handle typed in capitals goes the same way to
// its lower-case address. A key that names nothing is the usual 404.
//
// The site's sign and player pages and a player's feeds use these, and so do Quiz's sign pages.

import type { Context, MiddlewareHandler } from 'hono';
import { API_VERSION } from '../api/contract.ts';
import { isPublic, signPath } from '../api/views.ts';
import type { Player, Sign } from '../domain/types.ts';
import { PAGE_CACHE } from '../edge-cache.ts';
import { frontOf } from '../front.ts';
import type { Store } from '../store/store.ts';

/** What a key in an address found, and whether the key was already the name. */
export type Found<T> = { found: T; canonical: boolean };

/** The sign a key names: its slug, else its id or its slug in any case. */
export function signByKey(signs: readonly Sign[], key: string): Found<Sign> | undefined {
  const named = signs.find((s) => s.slug === key);
  if (named) return { found: named, canonical: true };
  const upper = key.toUpperCase();
  const lower = key.toLowerCase();
  const other = signs.find((s) => s.id === upper) ?? signs.find((s) => s.slug === lower);
  return other && { found: other, canonical: false };
}

/** The player a key names: their handle, else their id or their handle in any case. */
export function playerByKey(players: Iterable<Player>, key: string): Found<Player> | undefined {
  const all = [...players];
  const named = all.find((p) => p.handle === key);
  if (named) return { found: named, canonical: true };
  const upper = key.toUpperCase();
  const lower = key.toLowerCase();
  const other = all.find((p) => p.id === upper) ?? all.find((p) => p.handle === lower);
  return other && { found: other, canonical: false };
}

/** The request's query string, "?view=map", or "" when it has none. */
export const queryOf = (c: Context): string => new URL(c.req.url).search;

/**
 * A 301 to `path` with the request's query string, kept at the edge a day like the page it leads
 * to: the address it answers for never names anything else.
 */
export function movedTo(c: Context, path: string): Response {
  c.header('Cache-Control', PAGE_CACHE);
  return c.redirect(`${path}${queryOf(c)}`, 301);
}

/** A sign's address on either front or in the API: the prefix, the key, and what follows it. */
const SIGN_ADDRESS = /^(\/api\/v1)?\/signs\/([^/]+)(\/.*)?$/;

/**
 * The slug of a sign the owner merged into another (`merge-signs` in src/owner.ts) keeps leading
 * there: its `SLUG#` row points at the kept sign and says which sign it was claimed for, so a GET of
 * `/signs/<old slug>` (the site, Quiz) or `/api/v1/signs/<old slug>` is a 301 to the kept sign's
 * address, with the rest of the path and the query kept. Data, not a list of slugs: a slug whose
 * row was never moved, or whose kept sign is gone or not shown, goes on to the usual answer.
 * It costs one read of the slug's row per sign address the origin answers (the edge keeps the
 * site's a day); an id address, which has no row, goes on after that read.
 */
export function mergedSlugs(store: Store): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const match = method === 'GET' || method === 'HEAD' ? SIGN_ADDRESS.exec(c.req.path) : null;
    const key = match?.[2];
    if (!match || !key || !/^[a-z0-9-]+$/.test(key)) return next();
    const held = await store.slugHolder(key).catch(() => undefined);
    if (!held?.movedFrom) return next();
    const sign = await store.getSign(held.signId);
    if (!sign || !isPublic(sign) || sign.slug === key) return next();
    const api = match[1] ?? '';
    c.header('Cache-Control', api || frontOf(c) === 'site' ? PAGE_CACHE : 'no-store');
    if (api) c.header('API-Version', API_VERSION);
    return c.redirect(`${api}${signPath(sign)}${match[3] ?? ''}${queryOf(c)}`, 301);
  };
}
