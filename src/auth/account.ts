// What a signed-in player can change about themselves: their name and bio, and deleting the
// account with everything it made.

import { fail } from '../api/errors.ts';
import { text } from '../api/input.ts';
import { slugify } from '../domain/ids.ts';
import type { Player } from '../domain/types.ts';
import { removePlayerHearts, removeSignKudos } from '../hearts.ts';
import type { PhotoStore } from '../photos.ts';
import type { Tinylytics } from '../tinylytics.ts';
import type { PlayerChanges, Store } from '../store/store.ts';

export const NAME_MAX = 40;
export const BIO_MAX = 160;

/** Reserves the handle a first name makes: the name's slug, or the slug with -2, -3 and so on. */
async function reserveHandle(store: Store, player: Player, name: string): Promise<string | undefined> {
  const base = slugify(name).slice(0, 30).replace(/-+$/, '');
  if (!base || base === 'sign') return undefined;
  const others = new Set((await store.allPlayers()).filter((p) => p.id !== player.id).map((p) => p.handle));
  for (let n = 1; n <= 100; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!others.has(handle) && (await store.claimHandle(handle, player.id))) return handle;
  }
  return undefined;
}

/**
 * Sets the name and bio. The first name a player gives also sets their handle (their page's
 * address), which stays put after that so links keep working. Each field is changed in place,
 * so two requests at once can't undo each other, and only one of them can set the handle.
 */
export async function updateMe(store: Store, player: Player, body: Record<string, unknown>): Promise<Player> {
  const unknown = Object.keys(body).filter((k) => k !== 'name' && k !== 'bio');
  if (unknown.length) fail('bad_request', `Only name and bio can change, not ${unknown.join(', ')}`);
  const changes: PlayerChanges = {};
  if ('name' in body) changes.name = text(body.name, 'name', NAME_MAX, 1);
  if ('bio' in body) changes.bio = (body.bio === null ? '' : text(body.bio, 'bio', BIO_MAX, 0)) || null;

  let done = false;
  if (changes.name && !player.name) {
    const handle = await reserveHandle(store, player, changes.name);
    if (handle) {
      done = await store.updatePlayer(player.id, { ...changes, handle }, true);
      if (done) await store.releaseHandle(player.handle, player.id);
      // Another request of this player's named them first, maybe with this same handle.
      else if ((await store.getPlayer(player.id))?.handle !== handle) await store.releaseHandle(handle, player.id);
    }
  }
  if (!done) await store.updatePlayer(player.id, changes);
  return (await store.getPlayer(player.id)) ?? fail('unauthorized', 'That account is gone');
}

/**
 * Deletes the player and what they made: the signs they posted (with their photos, every way on
 * them and their hearts), the ways they added to other signs, the hearts they gave, their place
 * among a sign's finders, their reports, and everything kept under them (sessions, uploads,
 * blocks) and their email. Photos uploaded and never posted go when the bucket clears uploads.
 * Hearts go first: if Tinylytics can't take them back, nothing else is deleted yet.
 */
export async function deleteAccount(
  deps: { store: Store; photos: PhotoStore; tinylytics?: Tinylytics },
  player: Player
): Promise<void> {
  const { store, photos } = deps;
  const signs = await store.allSigns();
  await removePlayerHearts(deps, player);
  await removeSignKudos(
    deps,
    signs.filter((s) => s.postedBy === player.id)
  );
  for (const sign of signs) {
    if (sign.postedBy === player.id) {
      // The photos go first, so a failed removal leaves the sign for the next try.
      for (const photo of sign.photos) await photos.remove(photo.id);
      await store.deleteSign(sign.id);
      continue;
    }
    await store.deleteReport(sign.id, player.id);
    const ways = await store.listWays(sign.id);
    const theirs = ways.filter((w) => w.playerId === player.id);
    const finders = sign.finders.filter((f) => f.playerId !== player.id);
    if (!theirs.length && finders.length === sign.finders.length) continue;
    for (const way of theirs) await store.deleteWay(way);
    const left = await store.listWays(sign.id);
    await store.updateSign(sign.id, {
      finders,
      wayCount: left.length,
      firstWay: left[0] ? { text: left[0].text, value: left[0].value, playerId: left[0].playerId } : null
    });
  }
  await store.deletePlayer(player.id);
}
