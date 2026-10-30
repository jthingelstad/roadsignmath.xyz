// What a signed-in player can change about themselves: their name and bio, and deleting the
// account with everything it made.

import { fail } from '../api/errors.ts';
import { slugify } from '../domain/ids.ts';
import type { Player } from '../domain/types.ts';
import type { PlayerChanges, Store } from '../store/store.ts';

export const NAME_MAX = 40;
export const BIO_MAX = 160;

const CONTROL = /\p{Cc}/u;

function text(raw: unknown, field: string, max: number, min: number): string {
  if (typeof raw !== 'string') return fail('bad_request', `${field} must be text`);
  const value = raw.trim().replace(/\s+/g, ' ');
  if (CONTROL.test(raw.replace(/[\n\t]/g, ' '))) fail('bad_request', `${field} can't hold control characters`);
  if (value.length < min || value.length > max) {
    fail('bad_request', min ? `${field} is 1 to ${max} characters` : `${field} is at most ${max} characters`);
  }
  return value;
}

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
 * Deletes the player and what they made: the signs they posted (with every way on them), the ways
 * they added to other signs, their place among a sign's finders, their sessions and their email.
 */
export async function deleteAccount(store: Store, player: Player): Promise<void> {
  for (const sign of await store.allSigns()) {
    if (sign.postedBy === player.id) {
      await store.deleteSign(sign.id);
      continue;
    }
    const ways = await store.listWays(sign.id);
    const theirs = ways.filter((w) => w.playerId === player.id);
    const finders = sign.finders.filter((f) => f.playerId !== player.id);
    if (!theirs.length && finders.length === sign.finders.length) continue;
    for (const way of theirs) await store.deleteWay(way);
    const left = ways.filter((w) => w.playerId !== player.id);
    const next = { ...sign, finders, wayCount: left.length };
    if (left[0]) next.firstWay = { text: left[0].text, value: left[0].value };
    else delete next.firstWay;
    await store.putSign(next);
  }
  await store.deletePlayer(player.id);
}
