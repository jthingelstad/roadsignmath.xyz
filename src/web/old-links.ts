// The micro.blog's old addresses. roadsignmath.xyz was a micro.blog from 2023 to 2025, and links
// to its posts still arrive (Jamie, 2026-11-12: "redirect them where it makes sense"). Each one
// that has a clear home here goes there with a 301, kept at the edge like a page; the rest stay
// 404s.
//
// - A post, `/2021/08/02/wurtsboro.html`, goes to its sign's page, and so does its name alone
//   (`/wurtsboro`) when only one post had it and it is a word, not a time like `153816`.
// - A post's photo as the post showed it, `/uploads/2023/fd1726dfcd.jpg`, goes to that photo.
// - A category, `/categories/missouri`, goes to `/signs` showing that state's signs.
// - `/archive` and `/photos` go to `/signs`, and `/feed` to `/feed.xml`.
//
// Each post's sign is found at request time: a seeded sign's id ends in the hash of its post
// (`seedKeys` in src/seed/microblog.ts), so a renamed sign is still found and its address comes
// from `signUrl`. A post whose sign the owner merged into another (`merge-signs`) goes to that one,
// found by the `merged` record, and so does each of its photos the merge kept. A sign that is gone
// or not shown is a 404, and so is a photo it no longer has.

import { Hono, type Context } from 'hono';
import launch from '../../seed/microblog.json' with { type: 'json' };
import { isPublic, photoUrl, signUrl, type Urls } from '../api/views.ts';
import { STATES } from '../domain/geo.ts';
import { slugify, ulidFrom } from '../domain/ids.ts';
import type { Sign } from '../domain/types.ts';
import { PAGE_CACHE } from '../edge-cache.ts';
import { seedKeys } from '../seed/microblog.ts';
import type { Store } from '../store/store.ts';

/** A micro.blog post: its path, "2021/08/02/wurtsboro.html", and its photos' paths in order. */
export type OldPost = { post: string; uploads: string[] };

/** The 16 posts seed/microblog.json made into signs. */
export const MICROBLOG_POSTS: OldPost[] = launch.signs.map(({ post, uploads }) => ({ post, uploads }));

/** The part of a seeded id that comes from its key: everything after the ten characters of time. */
const hashOf = (key: string): string => ulidFrom(0, key).slice(10);

/** A state's micro.blog category name, "new-york", to its code. */
const STATE_CODES = new Map(Object.entries(STATES).map(([code, name]) => [slugify(name), code]));

export function createOldLinks({
  store,
  urls,
  posts = MICROBLOG_POSTS
}: {
  store: Store;
  urls: Urls;
  posts?: OldPost[];
}): Hono {
  const old = new Hono();
  // Kept a day like the page it points to; a write that renames or hides a sign clears the edge.
  const moved = (c: Context, to: string) => {
    c.header('Cache-Control', PAGE_CACHE);
    return c.redirect(to, 301);
  };
  const shown = async () => (await store.allSigns()).filter(isPublic);
  /**
   * The post's sign, and the id it was seeded with: its own, or, when the owner merged it into
   * another sign (`merge-signs`), the merged sign's, which the photos it brought still carry.
   */
  const signOf = async (post: string): Promise<{ sign: Sign; seededId: string } | undefined> => {
    const hash = hashOf(seedKeys.sign(post));
    const signs = await shown();
    const own = signs.find((s) => s.id.slice(10) === hash);
    if (own) return { sign: own, seededId: own.id };
    for (const sign of signs) {
      const merged = sign.merged?.find((m) => m.signId.slice(10) === hash);
      if (merged) return { sign, seededId: merged.signId };
    }
    return undefined;
  };
  const toSign = (post: string) => async (c: Context) => {
    const found = await signOf(post);
    return found ? moved(c, signUrl(urls, found.sign)) : c.notFound();
  };

  const byName = new Map<string, string[]>();
  for (const { post, uploads } of posts) {
    old.get(`/${post}`, toSign(post));
    const name = post.slice(post.lastIndexOf('/') + 1).replace(/\.html$/, '');
    byName.set(name, [...(byName.get(name) ?? []), post]);
    uploads.forEach((upload, i) => {
      old.get(`/${upload}`, async (c) => {
        const found = await signOf(post);
        const id = found ? `${found.seededId.slice(0, 10)}${hashOf(seedKeys.photo(post, i))}`.toLowerCase() : '';
        return found?.sign.photos.some((p) => p.id === id) ? moved(c, photoUrl(urls, id, 'large')) : c.notFound();
      });
    });
  }
  for (const [name, [post, ...others]] of byName) {
    if (others.length || /^\d+$/.test(name)) continue;
    old.get(`/${name}`, toSign(post));
  }

  // Only a state with a shown sign: `/signs` ignores a state it has no signs for.
  old.get('/categories/:name', async (c) => {
    const code = STATE_CODES.get(c.req.param('name').toLowerCase());
    const any = code && (await shown()).some((s) => s.place.state === code);
    return any ? moved(c, `/signs?state=${code}`) : c.notFound();
  });
  old.get('/archive', (c) => moved(c, '/signs'));
  old.get('/photos', (c) => moved(c, '/signs'));
  old.get('/feed', (c) => moved(c, '/feed.xml'));
  return old;
}
