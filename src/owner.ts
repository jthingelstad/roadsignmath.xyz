// What the owner can do from the Mac when a report comes in (Jamie, 2026-11-10: "a Mac-side
// script to hide a sign or remove a player. No admin website."). tools/owner.ts wires it to the
// live stack; tests give it the memory store.
//
// - hide-sign <slug>: the state an upheld report leaves (`hideSign`): the photos leave `p/` and
//   CloudFront, the sign is `hidden`, so it leaves the site, the feeds, the open data and the API
//   for everyone but its poster, who sees the note.
// - unhide-sign <slug>: a hidden or held sign is shown again (`unhideSign`).
// - remove-player <handle>: exactly what `DELETE /me` does (`removePlayer`): the account and
//   everything it made, their hearts' kudos first, then their address leaves the newsletter.
//
// `check` only reads and says what would change. `live` writes, then clears the edge once, as a
// request that changed a page does. Never prints an email address.

import { removePlayer } from './auth/account.ts';
import type { Player, Sign } from './domain/types.ts';
import type { EdgeCache } from './edge-cache.ts';
import type { Newsletter } from './newsletter.ts';
import type { PhotoStore } from './photos.ts';
import { hideSign, unhideSign } from './posting/posting.ts';
import type { Store } from './store/store.ts';
import type { Tinylytics } from './tinylytics.ts';

export const OWNER_COMMANDS = ['hide-sign', 'unhide-sign', 'remove-player'] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];
export type OwnerMode = 'check' | 'live';

export type OwnerDeps = {
  store: Store;
  photos: PhotoStore;
  tinylytics?: Tinylytics;
  newsletter?: Newsletter;
  edgeCache?: EdgeCache;
  now?: () => Date;
};

/** What the poster of a sign the owner hid sees as its note, unless `--note` says otherwise. */
export const OWNER_HIDE_NOTE = 'Jamie took this sign down under the house rules.';

/** A command that can't go ahead: nothing was written. */
export class OwnerRefused extends Error {}

const refuse = (message: string): never => {
  throw new OwnerRefused(message);
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const named = (p: Player | undefined) =>
  !p ? 'a player no longer here' : p.name ? `${p.name} (@${p.handle})` : `@${p.handle}`;

async function signBySlug(store: Store, slug: string): Promise<Sign> {
  const sign = (await store.allSigns()).find((s) => s.slug === slug);
  return sign ?? refuse(`No sign with the slug ${slug}`);
}

async function describeSign(store: Store, sign: Sign): Promise<string> {
  const poster = await store.getPlayer(sign.postedBy);
  return `“${sign.title}” (${sign.slug}), posted by ${named(poster)}: ${sign.visibility}, ${plural(sign.photos.length, 'photo')}, ${plural(sign.wayCount, 'way')}`;
}

/** Holds the sign's report lease, so the owner and a player's report never change it at once. */
async function underReportLease<T>(store: Store, sign: Sign, run: () => Promise<T>): Promise<T> {
  const lease = `report:${sign.id}`;
  const holder = 'owner';
  if (!(await store.lease(lease, holder, 120)))
    refuse('A report of this sign is being looked at. Try again in a minute.');
  try {
    return await run();
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

async function clearEdge(deps: OwnerDeps, out: string[]): Promise<void> {
  if (!deps.edgeCache) {
    out.push('No distribution to clear: pages may show the old state for up to a day.');
    return;
  }
  try {
    await deps.edgeCache.clear();
    out.push('Cleared the edge.');
  } catch {
    out.push('Clearing the edge failed: clear it by hand, or pages show the old state for up to a day.');
  }
}

/**
 * Runs one owner command and returns what it says, line by line. `check` writes nothing. Throws
 * `OwnerRefused` when the target isn't there or can't be changed now.
 */
export async function runOwner(
  deps: OwnerDeps,
  command: OwnerCommand,
  target: string,
  mode: OwnerMode,
  options: { note?: string } = {}
): Promise<string[]> {
  const { store } = deps;
  const out: string[] = [];
  const live = mode === 'live';

  if (command === 'hide-sign') {
    const sign = await signBySlug(store, target);
    out.push(await describeSign(store, sign));
    if (sign.visibility === 'hidden') return [...out, 'Already hidden: nothing to do.'];
    const note = options.note?.trim() || OWNER_HIDE_NOTE;
    out.push(
      `${live ? 'Hiding' : 'Would hide'} it: ${sign.visibility === 'shown' ? 'its photos and page leave the site, the feeds and the API' : 'it stays out of sight'}, and its poster sees “${note}”.`
    );
    if (!live) return out;
    await underReportLease(store, sign, async () => {
      const fresh = (await store.getSign(sign.id, true)) ?? refuse('The sign is gone');
      await hideSign(deps, fresh, note, (deps.now?.() ?? new Date()).toISOString());
    });
    out.push('Hidden.');
    await clearEdge(deps, out);
    return out;
  }

  if (command === 'unhide-sign') {
    const sign = await signBySlug(store, target);
    out.push(await describeSign(store, sign));
    if (sign.visibility === 'shown') return [...out, 'Already shown: nothing to do.'];
    out.push(
      `${live ? 'Showing' : 'Would show'} it again: its photos and page are back on the site, the feeds and the API.`
    );
    if (!live) return out;
    await underReportLease(store, sign, async () => {
      const fresh = (await store.getSign(sign.id, true)) ?? refuse('The sign is gone');
      await unhideSign(deps, fresh);
    });
    out.push('Shown.');
    await clearEdge(deps, out);
    return out;
  }

  // remove-player
  const handle = target.replace(/^@/, '').toLowerCase();
  const player = (await store.allPlayers()).find((p) => p.handle === handle) ?? refuse(`No player @${handle}`);
  const signs = await store.allSigns();
  const posted = signs.filter((s) => s.postedBy === player.id);
  let ways = 0;
  for (const sign of signs.filter((s) => s.postedBy !== player.id)) {
    ways += (await store.listWays(sign.id)).filter((w) => w.playerId === player.id).length;
  }
  const finderOf = signs.filter((s) => s.postedBy !== player.id && s.finders.some((f) => f.playerId === player.id));
  const hearts = (await store.listHearts(player.id)).length;
  out.push(`${named(player)}, playing since ${player.createdAt.slice(0, 10)}`);
  out.push(
    `${live ? 'Removing' : 'Would remove'}: the account, ${plural(posted.length, 'sign')} they posted (with their photos, ways and hearts), ${plural(ways, 'way')} on other signs, their place among the finders of ${plural(finderOf.length, 'other sign')}, ${plural(hearts, 'heart')}, ${player.avatar ? 'their profile photo' : 'no profile photo'}, their reports and blocks, and their email address.`
  );
  out.push(
    player.email
      ? `Their address ${live ? 'leaves' : 'would leave'} the newsletter.`
      : 'No email address, so nothing to take off the newsletter.'
  );
  if (posted.length) out.push(`Their signs: ${posted.map((s) => s.slug).join(', ')}`);
  if (!live) return out;
  if (!deps.tinylytics) refuse('No Tinylytics key: their hearts’ kudos can’t be taken back, so nothing was removed.');
  if (player.email && !deps.newsletter)
    refuse('No newsletter key: their address can’t leave it, so nothing was removed.');
  const outcome = await removePlayer(deps, player);
  out.push(`Removed @${player.handle}.${outcome ? ` Newsletter: ${outcome}.` : ''}`);
  await clearEdge(deps, out);
  return out;
}
