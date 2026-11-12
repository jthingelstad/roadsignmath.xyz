// Pages are addressed by name: a sign at /signs/<slug> and a player at /players/<handle>. A
// sign's slug comes from its title when it is posted and a handle from a player's first name,
// and neither ever changes, so these addresses last. From 12 to 13 November 2026 the pages were
// addressed by id (/signs/<id>, /players/<id>); Jamie then chose the names again ("Approved: make
// the name addresses canonical again for signs and players, with id links redirecting to them").
// An id, in any case, goes to the name's address with a 301 that keeps the query string, so the
// links shared in those days still land. A key that names nothing is the usual 404.
//
// The site's sign and player pages and a player's feeds use these, and so do Quiz's sign pages.

import type { Context } from 'hono';
import type { Player, Sign } from '../domain/types.ts';
import { PAGE_CACHE } from '../edge-cache.ts';

/** What a key in an address found, and whether the key was already the name. */
export type Found<T> = { found: T; canonical: boolean };

/** The sign a key names: its slug, else its id in any case. */
export function signByKey(signs: readonly Sign[], key: string): Found<Sign> | undefined {
  const named = signs.find((s) => s.slug === key);
  if (named) return { found: named, canonical: true };
  const upper = key.toUpperCase();
  const byId = signs.find((s) => s.id === upper);
  return byId && { found: byId, canonical: false };
}

/** The player a key names: their handle, else their id in any case. */
export function playerByKey(players: Iterable<Player>, key: string): Found<Player> | undefined {
  const all = [...players];
  const named = all.find((p) => p.handle === key);
  if (named) return { found: named, canonical: true };
  const upper = key.toUpperCase();
  const byId = all.find((p) => p.id === upper);
  return byId && { found: byId, canonical: false };
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
