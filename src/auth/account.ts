// What a signed-in player can change about themselves: their name, bio and profile photo, and
// deleting the account with everything it made.

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../api/contract.ts';
import { fail } from '../api/errors.ts';
import { limit, text } from '../api/input.ts';
import { slugify, ulid } from '../domain/ids.ts';
import type { Player } from '../domain/types.ts';
import { heartLease, removePlayerHearts, removeSignKudos, sweepSignKudos } from '../hearts.ts';
import type { Moderator } from '../moderation/moderator.ts';
import { avatarRenditions, type PhotoStore } from '../photos.ts';
import { moderate, readPhoto } from '../posting/posting.ts';
import type { Tinylytics } from '../tinylytics.ts';
import { nowSeconds, type PlayerChanges, type Store } from '../store/store.ts';

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

/** Removes a replaced profile photo's files. A failure leaves them behind but changes nothing else. */
async function dropPhoto(photos: PhotoStore, id: string | undefined): Promise<void> {
  if (!id) return;
  await photos.remove(id).catch((err: Error) => console.error({ event: 'avatar-remove', outcome: err.name }));
}

/**
 * Sets the player's profile photo: cropped square, at two sizes, without its metadata (a profile
 * photo is often taken at home, so its location must never leave with it). The moderator looks
 * first and a photo it wouldn't show is refused. The new photo is public at once; the one it
 * replaces is removed.
 */
export async function setAvatar(
  deps: { store: Store; photos: PhotoStore; moderator: Moderator },
  player: Player,
  type: string | undefined,
  body: () => Promise<ArrayBuffer>,
  length: number | undefined
): Promise<Player> {
  const { store, photos, moderator } = deps;
  const bytes = await readPhoto(type, body, length);
  await limit(
    store,
    `avatars:${player.id}`,
    LIMITS.avatarsADay,
    86400,
    nowSeconds(),
    'Too many photos today. Try again tomorrow.'
  );
  const sized = await avatarRenditions(bytes).catch(() => fail('bad_request', 'That photo couldn’t be read'));
  const verdict = await moderate(() => moderator.reviewAvatar(sized.large));
  if (verdict.verdict !== 'ok') fail('refused', verdict.reason || 'That photo can’t be your profile photo.');
  const id = ulid().toLowerCase();
  // Under the player's lease, which deleting the account holds too: a delete either sees this
  // photo on the player and removes it, or runs after and finds it there.
  return underLease(store, player, async () => {
    let set: { previous?: string } | false;
    try {
      await photos.putUpload(id, sized);
      await photos.publish(id, 'shown');
      set = await store.setAvatar(player.id, id);
    } catch (err) {
      // The update may have landed before the error: keep the photo only if the player has it.
      const now = await store.getPlayer(player.id, true).catch(() => undefined);
      if (now?.avatar !== id) await dropPhoto(photos, id);
      throw err;
    }
    if (!set) {
      await dropPhoto(photos, id);
      return fail('unauthorized', 'That account is gone');
    }
    await dropPhoto(photos, set.previous);
    return (await store.getPlayer(player.id)) ?? fail('unauthorized', 'That account is gone');
  });
}

/** Runs a profile photo change under the player's lease (see `setAvatar`). */
async function underLease<T>(store: Store, player: Player, work: () => Promise<T>): Promise<T> {
  const lease = heartLease(player.id);
  const holder = randomUUID();
  if (!(await store.lease(lease, holder, 30))) fail('conflict', 'Your account is changing. Try again in a minute.');
  try {
    return await work();
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

/** Takes the profile photo down; the player shows their first letter again. */
export async function removeAvatar(deps: { store: Store; photos: PhotoStore }, player: Player): Promise<Player> {
  return underLease(deps.store, player, async () => {
    const set = await deps.store.setAvatar(player.id, null);
    if (!set) return fail('unauthorized', 'That account is gone');
    await dropPhoto(deps.photos, set.previous);
    return (await deps.store.getPlayer(player.id)) ?? fail('unauthorized', 'That account is gone');
  });
}

/**
 * Deletes the player and what they made: the signs they posted (with their photos, every way on
 * them and their hearts), the ways they added to other signs, the hearts they gave, their place
 * among a sign's finders, their reports, their profile photo, and everything kept under them (sessions, uploads,
 * blocks) and their email. Photos uploaded and never posted go when the bucket clears uploads.
 * Hearts go first: if Tinylytics can't take them back, nothing else is deleted yet.
 */
export async function deleteAccount(
  deps: { store: Store; photos: PhotoStore; tinylytics?: Tinylytics },
  player: Player
): Promise<void> {
  const { store } = deps;
  // The player's lease, held to the end, so no heart or profile photo of theirs changes meanwhile.
  const lease = heartLease(player.id);
  const holder = randomUUID();
  if (!(await store.lease(lease, holder, 300))) {
    fail('conflict', 'A heart of yours is changing. Try again in a minute.');
  }
  try {
    await deleteEverything(deps, player);
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

async function deleteEverything(
  deps: { store: Store; photos: PhotoStore; tinylytics?: Tinylytics },
  player: Player
): Promise<void> {
  const { store, photos } = deps;
  const signs = await store.allSigns();
  const theirSigns = signs.filter((s) => s.postedBy === player.id);
  await removePlayerHearts(deps, player);
  await removeSignKudos(deps, theirSigns);
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
  // Read again under the lease: a profile photo set since this request began goes too.
  const avatar = (await store.getPlayer(player.id, true))?.avatar ?? player.avatar;
  if (avatar) await photos.remove(avatar);
  await store.deletePlayer(player.id);
  // Other players' hearts made on their signs while those were deleted.
  await sweepSignKudos(deps, theirSigns);
}
