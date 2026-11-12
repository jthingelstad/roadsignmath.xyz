// Pages are addressed by id (Jamie, 2026-11-12: "anchor them on id's and not names"; "just use
// ID"): a sign at /signs/<id> and a player at /players/<id>, the id exactly as stored. The
// addresses from before, by slug and by handle, and an id typed in another case, go to the id's
// address with a 301 that keeps the query string. A key that names nothing is the usual 404.
//
// The site's sign and player pages and a player's feeds use these, and so do Quiz's sign pages.

import type { Context } from 'hono';
import type { Player, Sign } from '../domain/types.ts';
import { PAGE_CACHE } from '../edge-cache.ts';

/** What a key in an address found, and whether the key was already the id. */
export type Found<T> = { found: T; canonical: boolean };

/** The sign a key names: its id as stored, else the slug it had, else its id in another case. */
export function signByKey(signs: readonly Sign[], key: string): Found<Sign> | undefined {
  const exact = signs.find((s) => s.id === key);
  if (exact) return { found: exact, canonical: true };
  const upper = key.toUpperCase();
  const other = signs.find((s) => s.slug === key) ?? signs.find((s) => s.id === upper);
  return other && { found: other, canonical: false };
}

/** The player a key names: their id as stored, else their handle, else their id in another case. */
export function playerByKey(players: Iterable<Player>, key: string): Found<Player> | undefined {
  const all = [...players];
  const exact = all.find((p) => p.id === key);
  if (exact) return { found: exact, canonical: true };
  const upper = key.toUpperCase();
  const other = all.find((p) => p.handle === key) ?? all.find((p) => p.id === upper);
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
