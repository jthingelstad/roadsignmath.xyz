// What a signed-in player can change about themselves: their name, bio, website, home and profile
// photo, and deleting the account with everything it made.

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../api/contract.ts';
import { fail } from '../api/errors.ts';
import { limit, text } from '../api/input.ts';
import { isIP } from 'node:net';
import { slugify, ulid } from '../domain/ids.ts';
import type { Player } from '../domain/types.ts';
import { heartLease, removePlayerHearts, removeSignKudos, sweepSignKudos } from '../hearts.ts';
import type { Moderator, ProfileWords } from '../moderation/moderator.ts';
import { avatarRenditions, type PhotoStore } from '../photos.ts';
import { moderate, readPhoto } from '../posting/posting.ts';
import type { Tinylytics } from '../tinylytics.ts';
import { nowSeconds, type PlayerChanges, type Store } from '../store/store.ts';
import type { Newsletter, RemoveOutcome } from '../newsletter.ts';
import type { SignInFront } from '../mail/signin.ts';
import { product } from '../product.ts';

export const NAME_MAX = 40;
export const BIO_MAX = 160;
/** A website's address, as kept (an international name, in its ASCII form, can be longer than typed). */
export const WEBSITE_MAX = 200;
/** Home: a town or a state, in the player's words. */
export const HOME_MAX = 60;

const WEBSITE_BAD = 'website must be a web address, like example.com';

/**
 * A website as kept: an http or https address with a real host name, no user name or password, and
 * no spaces, normalised (lowercase host, an international name in its ASCII form). Without a scheme
 * it is https. Every other scheme (javascript:, data:, mailto:...) is refused. Empty is none.
 */
export function readWebsite(raw: unknown): string | null {
  if (raw === null) return null;
  // The same control, invisible and direction rules as a name; a space inside is never in an address.
  const typed = text(raw, 'website', WEBSITE_MAX, 0);
  if (!typed) return null;
  if (/\s/.test(typed)) return fail('bad_request', 'website can’t hold spaces');
  // A scheme is letters then a colon; "example.com:8080" is a host and a port, not a scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(typed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return fail('bad_request', 'website must be an http or https address');
  }
  let url: URL;
  try {
    url = new URL(scheme ? typed : `https://${typed}`);
  } catch {
    return fail('bad_request', WEBSITE_BAD);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('bad_request', 'website must be an http or https address');
  }
  if (url.username || url.password) return fail('bad_request', 'website can’t hold a user name or password');
  const host = url.hostname;
  // A name with a dot in it, not an IP address or a machine on someone's own network.
  if (!host.includes('.') || host.endsWith('.') || isIP(host.replace(/^\[|\]$/g, '')) || /^[\d.]+$/.test(host)) {
    return fail('bad_request', WEBSITE_BAD);
  }
  const kept = url.href;
  if (kept.length > WEBSITE_MAX) return fail('bad_request', `website is at most ${WEBSITE_MAX} characters`);
  return kept;
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

/** The fields `PATCH /me` and Quiz's profile can change. */
const PROFILE_FIELDS = ['name', 'bio', 'website', 'home'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

/**
 * Sets the name, bio, website and home. The first name a player gives also sets their handle
 * (their page's address), which stays put after that so links keep working. Each field is changed
 * in place, so two requests at once can't undo each other, and only one of them can set the
 * handle. The words that change go to the moderator first, together in one call, under the same
 * policy as a post: a refusal is a 422 with its sentence, and nothing is saved.
 */
export async function updateMe(
  deps: { store: Store; moderator: Moderator },
  player: Player,
  body: Record<string, unknown>
): Promise<Player> {
  const { store, moderator } = deps;
  const unknown = Object.keys(body).filter((k) => !(PROFILE_FIELDS as readonly string[]).includes(k));
  if (unknown.length) fail('bad_request', `Only name, bio, website and home can change, not ${unknown.join(', ')}`);
  const changes: PlayerChanges = {};
  if ('name' in body) changes.name = text(body.name, 'name', NAME_MAX, 1);
  if ('bio' in body) changes.bio = (body.bio === null ? '' : text(body.bio, 'bio', BIO_MAX, 0)) || null;
  if ('website' in body) changes.website = readWebsite(body.website);
  if ('home' in body) changes.home = (body.home === null ? '' : text(body.home, 'home', HOME_MAX, 0)) || null;

  // Nothing to change, or nothing that differs from what is kept (read consistently, so a change
  // made a moment ago counts): no write, so no page is cleared from the edge, and no try is counted.
  const kept = (await store.getPlayer(player.id, true)) ?? fail('unauthorized', 'That account is gone');
  const changed = PROFILE_FIELDS.filter((f) => changes[f] !== undefined && changes[f] !== (kept[f] ?? null));
  if (!changed.length) return kept;
  for (const field of PROFILE_FIELDS) if (!changed.includes(field)) delete changes[field];
  // Every change clears the website's pages at the edge, so a player gets a day's worth and no more.
  await limit(
    store,
    `profile:${player.id}`,
    LIMITS.profileEditsADay,
    86400,
    nowSeconds(),
    'Too many changes today. Try again tomorrow.'
  );
  const first = changed.includes('name') && !kept.name;
  // Only words being put up are looked at; one being taken away needs no look.
  const words: ProfileWords = {};
  for (const field of changed) {
    const value = changes[field];
    if (value) words[field] = value;
  }
  if (Object.keys(words).length) {
    const verdict = await moderate(store, 'profile', () => moderator.reviewProfile(words));
    if (verdict.verdict !== 'ok') {
      product({ action: 'words-refused', first });
      fail('refused', verdict.reason || 'Our moderator wouldn’t show that on your profile.');
    }
  }

  let done = false;
  if (changes.name && !kept.name) {
    const handle = await reserveHandle(store, player, changes.name);
    if (handle) {
      done = await store.updatePlayer(player.id, { ...changes, handle }, true);
      if (done) await store.releaseHandle(kept.handle, player.id);
      // Another request of this player's named them first, maybe with this same handle.
      else if ((await store.getPlayer(player.id))?.handle !== handle) await store.releaseHandle(handle, player.id);
    }
  }
  if (!done) await store.updatePlayer(player.id, changes);
  product({ action: 'profile', part: profilePart(changed), first });
  return (await store.getPlayer(player.id)) ?? fail('unauthorized', 'That account is gone');
}

/** What a profile change was, for the dashboard: one field, name and bio as before, or several. */
function profilePart(changed: ProfileField[]): 'name' | 'bio' | 'name-and-bio' | 'website' | 'home' | 'several' {
  if (changed.length === 1) return changed[0];
  if (changed.length === 2 && changed.includes('name') && changed.includes('bio')) return 'name-and-bio';
  return 'several';
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
  const verdict = await moderate(store, 'avatar', () => moderator.reviewAvatar(sized.large));
  if (verdict.verdict !== 'ok') product({ action: 'photo-refused' });
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
      // The update may have landed before the error: drop the photo only once a read shows the
      // player without it. A read that fails too leaves it, since the player may be showing it.
      const now = await store.getPlayer(player.id, true).then(
        (p) => ({ read: true, avatar: p?.avatar }),
        () => ({ read: false, avatar: undefined })
      );
      if (now.read && now.avatar !== id) await dropPhoto(photos, id);
      throw err;
    }
    if (!set) {
      await dropPhoto(photos, id);
      return fail('unauthorized', 'That account is gone');
    }
    await dropPhoto(photos, set.previous);
    product({ action: 'profile', part: 'photo' });
    // Read consistently, so the answer never carries the photo just replaced.
    return (await store.getPlayer(player.id, true)) ?? fail('unauthorized', 'That account is gone');
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
    product({ action: 'profile', part: 'photo-removed' });
    return (await deps.store.getPlayer(player.id, true)) ?? fail('unauthorized', 'That account is gone');
  });
}

/**
 * Deletes the player and what they made: the signs they posted (with their photos, every way on
 * them and their hearts), the ways they added to other signs (with others' credit on them), the
 * ways they found too, the hearts they gave, their place
 * among a sign's finders, their reports (of signs and of players), their profile photo, everything kept
 * under them (sessions, uploads, blocks, other players' reports of them) and their email. Photos uploaded and never posted go when the bucket clears uploads.
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

/**
 * `DELETE /me`, and the owner's `remove-player` (tools/owner.ts) with the same code: the account
 * and everything it made go (`deleteAccount`), then the address leaves the newsletter. That last
 * step is best-effort: a failure is logged by outcome and doesn't undo the delete.
 */
export async function removePlayer(
  deps: { store: Store; photos: PhotoStore; tinylytics?: Tinylytics; newsletter?: Newsletter },
  player: Player
): Promise<RemoveOutcome | undefined> {
  const email = player.email;
  await deleteAccount(deps, player);
  product({ action: 'account-deleted' });
  if (!email || !deps.newsletter) return undefined;
  const outcome = await deps.newsletter.remove(email);
  console.log({ event: 'newsletter', op: 'remove', outcome });
  return outcome;
}

/**
 * After a sign-in: a new player joins the newsletter tagged with where they signed in (`app` or
 * `quiz`), and a player signing in somewhere new for them gets that tag added (Jamie, 2026-11-12).
 * The tags Buttondown confirms are kept on the player, so a missed one is tried again at their next
 * sign-in there. Best-effort: logged by outcome only, never in the way of signing in.
 */
export async function newsletterAtSignIn(
  deps: { store: Store; newsletter?: Newsletter },
  done: { player: Player; isNew: boolean },
  via: SignInFront
): Promise<void> {
  const { player, isNew } = done;
  if (!player.email || !deps.newsletter) return;
  if (via === 'site') {
    // The website's sign-in has no tag (`/privacy` names only the app and Quiz): a new player joins
    // the list untagged, and one already there is left as they are.
    if (isNew) console.log({ event: 'newsletter', op: 'add', outcome: await deps.newsletter.add(player.email) });
    return;
  }
  if (player.newsletterTags?.includes(via)) return;
  // Tagging reads the subscriber's tags and writes them back, so one sign-in at a time per player.
  // A busy lease skips it: nothing is recorded, and the next sign-in there tries again.
  const lease = newsletterLease(player.id);
  const holder = randomUUID();
  if (!(await deps.store.lease(lease, holder, 30))) {
    console.log({ event: 'newsletter', op: 'tag', tag: via, outcome: 'busy' });
    return;
  }
  try {
    const had = (await deps.store.getPlayer(player.id, true))?.newsletterTags ?? [];
    if (had.includes(via)) return;
    let confirmed = false;
    if (isNew) {
      const outcome = await deps.newsletter.add(player.email, [via]);
      console.log({ event: 'newsletter', op: 'add', outcome });
      confirmed = outcome === 'added';
    }
    // Someone already on the list, the new player Buttondown already had included, is tagged.
    if (!confirmed) {
      const outcome = await deps.newsletter.tag(player.email, [via]);
      console.log({ event: 'newsletter', op: 'tag', tag: via, outcome });
      confirmed = outcome === 'tagged' || outcome === 'already';
    }
    if (confirmed) await deps.store.setNewsletterTags(player.id, [...had, via]);
  } catch (err) {
    console.error({ event: 'newsletter', op: 'tag', outcome: 'failed', detail: (err as Error).name });
  } finally {
    await deps.store.endLease(lease, holder).catch(() => undefined);
  }
}

/** The lease a player's newsletter tags are changed under, by the server and `npm run newsletter`. */
export const newsletterLease = (playerId: string): string => `newsletter:${playerId}`;

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
    await store.deleteDuplicate(sign.id, player.id);
    const ways = await store.listWays(sign.id);
    const theirs = ways.filter((w) => w.playerId === player.id);
    // Their ways go before the co-finds are read: a co-find is only added while its way is there,
    // so none can land on one of their ways after this sweep.
    for (const way of theirs) await store.deleteWay(way);
    // Their credit on others' ways goes, and so does others' credit on their ways, with the way.
    const gone = new Set(theirs.map((w) => w.id));
    for (const coFind of await store.listCoFinds(sign.id)) {
      if (coFind.playerId === player.id || gone.has(coFind.wayId)) await store.deleteCoFind(coFind);
    }
    const finders = sign.finders.filter((f) => f.playerId !== player.id);
    if (!theirs.length && finders.length === sign.finders.length) continue;
    const left = await store.listWays(sign.id);
    await store.updateSign(sign.id, {
      finders,
      wayCount: left.length,
      firstWay: left[0] ? { text: left[0].text, value: left[0].value, playerId: left[0].playerId } : null
    });
  }
  // Their reports of other players; reports of them go with their own rows in deletePlayer.
  for (const other of await store.allPlayers()) {
    if (other.id === player.id) continue;
    if (await store.getPlayerReport(other.id, player.id)) await store.deletePlayerReport(other.id, player.id);
  }
  // Read again under the lease: a profile photo set since this request began goes too.
  const avatar = (await store.getPlayer(player.id, true))?.avatar ?? player.avatar;
  if (avatar) await photos.remove(avatar);
  await store.deletePlayer(player.id);
  // A solve of theirs that was under way may have credited them after their sign's sweep above.
  // With the player gone none can be added now, so this consistent sweep leaves none behind.
  for (const sign of signs) {
    if (sign.postedBy === player.id) continue;
    for (const coFind of await store.listCoFinds(sign.id)) {
      if (coFind.playerId === player.id) await store.deleteCoFind(coFind);
    }
  }
  // Other players' hearts made on their signs while those were deleted.
  await sweepSignKudos(deps, theirSigns);
}
