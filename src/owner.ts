// What the owner can do from the Mac when a report comes in (Jamie, 2026-11-10: "a Mac-side
// script to hide a sign or remove a player. No admin website."). tools/owner.ts wires it to the
// live stack; tests give it the memory store.
//
// - hide-sign <slug>: the state an upheld report leaves (`hideSign`): the photos leave `p/` and
//   CloudFront, the sign is `hidden`, so it leaves the site, the feeds, the open data and the API
//   for everyone but its poster, who sees the note.
// - unhide-sign <slug>: a hidden or held sign is shown again (`unhideSign`).
// - set-place <slug>: puts the sign where the owner says, with its label, state and whether the pin is
//   only approximate (Jamie, 2026-11-11, placing the signs abroad and Gross Vehicle Weight).
// - remove-way <slug> --way <id>: takes one way off a sign, with the co-finds on it, and keeps the
//   sign's count and first way in step, as an account delete does for its ways (Jamie,
//   2026-11-12: "remove my West Warwick 2+2=4 way"). Without --way, `check` lists the sign's ways
//   and their ids.
// - remove-player <handle>: exactly what `DELETE /me` does (`removePlayer`): the account and
//   everything it made, their hearts' kudos first, then their address leaves the newsletter.
// - merge-signs <keep> <drop>: one road sign posted twice becomes one sign, the kept one, with the
//   photos, dates, place and caption the owner picks from both, every way and finder, and the
//   dropped sign's hearts; the dropped slug leads to the kept sign from then on (Jamie,
//   2026-11-12: "Merge the two genesis signs into a single sign with two photos.").
// - set-alt --file <alts.json>: photo alt text from a list the owner wrote after looking at the
//   photos, replacing only the generic "Photo of the … sign" unless --force (Jamie, 2026-11-12).
//
// `check` only reads and says what would change. `live` writes, then clears the edge once, as a
// request that changed a page does. Never prints an email address.

import { randomUUID } from 'node:crypto';
import { removePlayer } from './auth/account.ts';
import { heartPath } from './api/views.ts';
import { numbersNotOnSign, sameWayKey } from './domain/equation.ts';
import type { CoFind, Finder, Heart, MergeRecord, Photo, Place, Player, Sign, Way } from './domain/types.ts';
import type { EdgeCache } from './edge-cache.ts';
import { heartLease, heartUid, removeSignKudos, sweepSignKudos } from './hearts.ts';
import { plainAlt } from './moderation/moderator.ts';
import type { Newsletter } from './newsletter.ts';
import type { PhotoStore } from './photos.ts';
import { hideSign, unhideSign } from './posting/posting.ts';
import type { Store } from './store/store.ts';
import type { Tinylytics } from './tinylytics.ts';

export const OWNER_COMMANDS = [
  'hide-sign',
  'unhide-sign',
  'set-place',
  'remove-way',
  'remove-player',
  'merge-signs',
  'set-alt'
] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];
export type OwnerMode = 'check' | 'live';

export type OwnerDeps = {
  store: Store;
  photos: PhotoStore;
  tinylytics?: Tinylytics;
  newsletter?: Newsletter;
  edgeCache?: EdgeCache;
  now?: () => Date;
  /**
   * The public count of kudos at a path, for `merge-signs --to check` without the Tinylytics key
   * (the tool reads the sign's `hearts` from the public API). Undefined when it can't be read.
   */
  kudoCount?: (path: string) => Promise<number | undefined>;
};

/** What the poster of a sign the owner hid sees as its note, unless `--note` says otherwise. */
export const OWNER_HIDE_NOTE = 'Jamie took this sign down under the house rules.';

/** A command that can't go ahead: nothing was written. */
export class OwnerRefused extends Error {}

const refuse = (message: string): never => {
  throw new OwnerRefused(message);
};

const where = (p: Place) =>
  `${p.label}${p.state ? ` [${p.state}]` : ''}, ${p.lat === undefined ? 'no pin' : `${p.lat}, ${p.lng}`}${p.approximate ? ' (approximate)' : ''}`;
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
  // A holder of its own, so two owner commands on one sign can't both hold it.
  const holder = `owner-${randomUUID()}`;
  if (!(await store.lease(lease, holder, 120)))
    refuse('A report of this sign is being looked at. Try again in a minute.');
  try {
    return await run();
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

/**
 * Runs a live write, then clears the edge once, even when the write fails partway: like
 * `PageChanges`, a write that failed may still have changed a page.
 */
async function thenClear(deps: OwnerDeps, out: string[], write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } finally {
    await clearEdge(deps, out);
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
 * Sets the sign's way count and first way from its ways. A way added between the read and the
 * write (`addWay` takes no lease) would be overwritten, so the ways are read again after the
 * write, and written again until the two reads agree.
 */
async function settleWays(store: Store, signId: string): Promise<void> {
  let ways = await store.listWays(signId);
  for (let tries = 0; tries < 5; tries++) {
    const first = ways[0];
    const written = await store.updateSign(signId, {
      wayCount: ways.length,
      firstWay: first ? { text: first.text, value: first.value, playerId: first.playerId } : null
    });
    if (!written) refuse('The sign is gone');
    const again = await store.listWays(signId);
    if (again.map((w) => w.id).join() === ways.map((w) => w.id).join()) return;
    ways = again;
  }
  refuse('Ways kept changing on this sign: run it again to set its count');
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
  options: {
    note?: string;
    place?: Partial<Place>;
    way?: string;
    merge?: Omit<MergeOptions, 'drop'> & { drop?: string };
    alts?: unknown;
    force?: boolean;
  } = {}
): Promise<string[]> {
  if (command === 'merge-signs') {
    const drop = options.merge?.drop ?? refuse('merge-signs needs the sign to keep and the sign to drop');
    return mergeSigns(deps, target, drop, mode, { ...options.merge, drop });
  }
  if (command === 'set-alt') return setAlts(deps, options.alts, mode, options.force ?? false);
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
      await thenClear(deps, out, async () => {
        await hideSign(deps, fresh, note, (deps.now?.() ?? new Date()).toISOString());
        out.push('Hidden.');
      });
    });
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
      await thenClear(deps, out, async () => {
        await unhideSign(deps, fresh);
        out.push('Shown.');
      });
    });
    return out;
  }

  if (command === 'set-place') {
    const sign = await signBySlug(store, target);
    out.push(await describeSign(store, sign));
    const given = options.place ?? {};
    const { lat, lng } = given;
    if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng))
      refuse('set-place needs --lat and --lng');
    if (Math.abs(lat!) > 90 || Math.abs(lng!) > 180) refuse(`${lat}, ${lng} is not a place on Earth`);
    const label = given.label?.trim() || sign.place.label;
    const state = given.state === undefined ? sign.place.state : given.state.trim().toUpperCase() || undefined;
    if (state !== undefined && !/^[A-Z]{2}$/.test(state)) refuse(`${state} is not a two-letter state`);
    const place: Place = { label, ...(state ? { state } : {}), lat, lng, approximate: given.approximate ?? false };
    out.push(`Now: ${where(sign.place)}`);
    out.push(`${live ? 'Moving it to' : 'Would move it to'}: ${where(place)}`);
    if (!live) return out;
    await underReportLease(store, sign, async () => {
      await thenClear(deps, out, async () => {
        if (!(await store.updateSign(sign.id, { place }))) refuse('The sign is gone');
        out.push('Moved.');
      });
    });
    return out;
  }

  if (command === 'remove-way') {
    const sign = await signBySlug(store, target);
    out.push(await describeSign(store, sign));
    const ways = await store.listWays(sign.id);
    const people = new Map((await store.allPlayers()).map((p) => [p.id, p]));
    const line = (w: (typeof ways)[number]) =>
      `${w.id}  ${w.text}  by ${named(people.get(w.playerId))}, ${w.createdAt.slice(0, 10)}`;
    const id = options.way?.trim();
    if (!id) {
      if (live) refuse('remove-way --to live needs --way <id>');
      return [...out, ...ways.map(line), 'Name the way to remove with --way <id>.'];
    }
    const way = ways.find((w) => w.id === id) ?? refuse(`No way ${id} on this sign`);
    const coFinds = (await store.listCoFinds(sign.id)).filter((c) => c.wayId === way.id);
    out.push(line(way));
    out.push(
      `${live ? 'Removing' : 'Would remove'} it and ${plural(coFinds.length, 'co-find')} on it; the sign keeps ${plural(ways.length - 1, 'way')}.`
    );
    if (!live) return out;
    await underReportLease(store, sign, async () => {
      await thenClear(deps, out, async () => {
        await store.deleteWay(way);
        for (const coFind of await store.listCoFinds(sign.id)) {
          if (coFind.wayId === way.id) await store.deleteCoFind(coFind);
        }
        await settleWays(store, sign.id);
        out.push('Removed.');
      });
    });
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
  await thenClear(deps, out, async () => {
    const outcome = await removePlayer(deps, player);
    out.push(`Removed @${player.handle}.${outcome ? ` Newsletter: ${outcome}.` : ''}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// merge-signs

/**
 * What `merge-signs` takes from the dropped sign. Each choice is explicit, and each default keeps
 * the kept sign's. `photos` is the photos the merged sign ends with, in order: `drop:1,keep:1`
 * (1 is each sign's first photo); left out, it is the kept sign's photos, then the dropped sign's.
 * A photo left out is deleted, as a deleted sign's is.
 */
export type MergeOptions = {
  drop: string;
  foundOn?: 'drop' | 'keep';
  postedAt?: 'drop' | 'keep';
  place?: 'drop' | 'keep';
  caption?: 'keep' | 'drop' | 'both';
  /** One exact sentence to take off the end of the merged caption; refused when it isn't there. */
  captionTrim?: string;
  photos?: string;
};

/** As many photos as a post can have. */
const MAX_PHOTOS = 4;

const wayKey = (text: string): string => sameWayKey(text) ?? text;

type Pick2 = { from: 'keep' | 'drop'; index: number; photo: Photo };

/** The photos the merged sign ends with, from the `--photos` spec. */
function pickPhotos(keep: Sign, drop: Sign, spec: string | undefined): Pick2[] {
  const all: Pick2[] = [
    ...keep.photos.map((photo, i) => ({ from: 'keep' as const, index: i + 1, photo })),
    ...drop.photos.map((photo, i) => ({ from: 'drop' as const, index: i + 1, photo }))
  ];
  const picked = spec?.trim()
    ? spec.split(',').map((part) => {
        const m = /^(keep|drop):(\d+)$/.exec(part.trim());
        if (!m) refuse(`--photos is a list like drop:1,keep:1,keep:2; “${part.trim()}” isn’t one`);
        const from = m![1] as 'keep' | 'drop';
        const index = Number(m![2]);
        const sign = from === 'keep' ? keep : drop;
        if (index < 1 || index > sign.photos.length)
          refuse(`${sign.slug} has ${plural(sign.photos.length, 'photo')}: ${part.trim()} isn’t one`);
        return all.find((p) => p.from === from && p.index === index)!;
      })
    : all;
  if (new Set(picked.map((p) => p.photo.id)).size !== picked.length) refuse('--photos names a photo twice');
  if (!picked.length) refuse('The merged sign needs a photo');
  if (picked.length > MAX_PHOTOS)
    refuse(`A sign has at most ${MAX_PHOTOS} photos: name which to keep with --photos (like drop:1,keep:1)`);
  return picked;
}

/** The merged caption: the kept one, the dropped one, or both, less one exact trailing sentence. */
function mergedCaption(keep: Sign, drop: Sign, choice: MergeOptions['caption'], trim?: string): string | undefined {
  const parts = choice === 'drop' ? [drop.caption] : choice === 'both' ? [keep.caption, drop.caption] : [keep.caption];
  let caption = parts
    .map((c) => c?.trim())
    .filter(Boolean)
    .join('\n\n');
  if (trim !== undefined) {
    const sentence = trim.trim();
    if (!sentence || !caption.endsWith(sentence))
      refuse(`The merged caption doesn’t end with “${sentence}”, so there is nothing to trim: nothing was changed`);
    caption = caption.slice(0, caption.length - sentence.length).trimEnd();
  }
  return caption || undefined;
}

/** Everyone credited on either sign, the kept sign's first, each player or plain name once. */
function mergedFinders(keep: Sign, drop: Sign): Finder[] {
  const out = [...keep.finders];
  for (const f of drop.finders) {
    const same = out.some((g) =>
      f.playerId ? g.playerId === f.playerId : !g.playerId && g.name.toLowerCase() === f.name.toLowerCase()
    );
    if (!same) out.push(f);
  }
  return out;
}

/** What happens to one of the dropped sign's ways. */
type WayPlan = {
  way: Way;
  coFinds: CoFind[];
  /** The same way on the kept sign: the dropped one goes, and its finders are credited there. */
  into?: Way;
  /** Players to credit on `into`, who aren't its author or credited on it already. */
  credit: string[];
  /** Already on the kept sign under its own id: an earlier run moved it. */
  moved: boolean;
};

async function planWays(store: Store, keep: Sign, drop: Sign): Promise<WayPlan[]> {
  const [keptWays, keptCoFinds, dropWays, dropCoFinds] = await Promise.all([
    store.listWays(keep.id),
    store.listCoFinds(keep.id),
    store.listWays(drop.id),
    store.listCoFinds(drop.id)
  ]);
  const numbers = keep.numbers.map((n) => n.value);
  return dropWays.map((way) => {
    const coFinds = dropCoFinds.filter((c) => c.wayId === way.id);
    const moved = keptWays.some((w) => w.id === way.id);
    const into = moved ? undefined : keptWays.find((w) => w.text === way.text || wayKey(w.text) === wayKey(way.text));
    if (!moved && !into) {
      const off = numbersNotOnSign(way.numbers, numbers);
      if (off.length)
        refuse(
          `The way ${way.text} (${way.id}) on ${drop.slug} uses ${off.join(', ')}, which ${keep.slug} doesn’t show that often: take it off with remove-way first`
        );
    }
    const credit: string[] = [];
    if (into) {
      const already = new Set([
        into.playerId,
        ...keptCoFinds.filter((c) => c.wayId === into.id).map((c) => c.playerId)
      ]);
      for (const id of [way.playerId, ...coFinds.map((c) => c.playerId)]) {
        if (!already.has(id)) {
          already.add(id);
          credit.push(id);
        }
      }
    }
    return { way, coFinds, into, credit, moved };
  });
}

/** Every player's heart on the dropped sign, and whether they hearted the kept one too. */
async function planHearts(store: Store, keep: Sign, drop: Sign) {
  const out: { player: Player; heart: Heart; onKeep?: Heart }[] = [];
  for (const player of await store.allPlayers()) {
    const hearts = await store.listHearts(player.id);
    const heart = hearts.find((h) => h.signId === drop.id);
    if (heart) out.push({ player, heart, onKeep: hearts.find((h) => h.signId === keep.id) });
  }
  return out;
}

/** The kudos at a sign's path: from Tinylytics with the key, else the public count. */
async function kudosAt(deps: OwnerDeps, sign: Sign): Promise<{ uids?: string[]; count?: number }> {
  if (deps.tinylytics) {
    const kudos = await deps.tinylytics.kudos(heartPath(sign));
    return { uids: kudos.map((k) => k.uid), count: kudos.length };
  }
  return { count: await deps.kudoCount?.(heartPath(sign)).catch(() => undefined) };
}

/** Players' reports and duplicate reports of the sign, which go with it. */
async function reportsOn(store: Store, sign: Sign): Promise<{ reports: number; duplicates: number }> {
  let reports = 0;
  let duplicates = 0;
  for (const player of await store.allPlayers()) {
    if (await store.getReport(sign.id, player.id)) reports++;
    if (await store.getDuplicate(sign.id, player.id)) duplicates++;
  }
  return { reports, duplicates };
}

/** Holds both signs' report leases, so no report or other owner command changes either meanwhile. */
async function underBothLeases<T>(store: Store, keep: Sign, drop: Sign, run: () => Promise<T>): Promise<T> {
  return underReportLease(store, keep, () => underReportLease(store, drop, run));
}

/**
 * Moves one player's heart from the dropped sign to the kept one, with the heart code's keys: a row
 * and a kudo at the kept sign's path under the uid `heartUid` gives it, then the old kudo and row go.
 * A player who hearted both keeps the one on the kept sign. Holds the player's heart lease, so it
 * never crosses their own heart or their account's delete.
 */
async function moveHeart(
  deps: OwnerDeps & { tinylytics: Tinylytics },
  keep: Sign,
  drop: Sign,
  { player, heart, onKeep }: { player: Player; heart: Heart; onKeep?: Heart }
): Promise<void> {
  const { store, tinylytics } = deps;
  const lease = heartLease(player.id);
  const holder = `owner-${randomUUID()}`;
  if (!(await store.lease(lease, holder, 60)))
    refuse(`A heart of @${player.handle}’s is changing: run it again in a minute`);
  try {
    if (!onKeep && !(await store.getHeart(player.id, keep.id))) {
      const uid = heartUid(player.id, keep.id);
      await store.putHeart({ playerId: player.id, signId: keep.id, uid, createdAt: heart.createdAt });
      try {
        await tinylytics.addKudo(heartPath(keep), uid);
      } catch (err) {
        // As a heart does: take it back in case it was made, and the row with it if that worked.
        if (
          await tinylytics.removeKudo(uid).then(
            () => true,
            () => false
          )
        )
          await store.deleteHeart(player.id, keep.id);
        throw err;
      }
    }
    await tinylytics.removeKudo(heart.uid);
    await store.deleteHeart(player.id, drop.id);
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

/** A short line about a photo: its id and alt text. */
const photoLine = (p: Pick2) => `${p.from}:${p.index} ${p.photo.id} “${p.photo.alt}”`;

/**
 * `merge-signs <keep> <drop>`: the dropped sign becomes part of the kept one, which keeps its id,
 * slug, title, numbers, hearts and address (and with them its feed item, share card and old
 * links). The dropped sign's photos that stay are re-pointed, not copied: a photo's files are
 * keyed by its own id (`p/<photoId>/…`), whichever sign shows it, so only the kept sign's row
 * changes. Its ways move over unless the kept sign has the same way, whose finders are credited
 * there instead; its players' hearts move over; its reports go with it; and its slug's row points
 * at the kept sign, so its old address leads there with a 301 (`mergedSlugs` in permalinks.ts).
 *
 * The writes run in an order that a re-run finishes: hearts and kudos first (Tinylytics, as a
 * delete does), then the photo files, then the kept sign's fields in one write that records the
 * merge (`merged`), then the ways, the slug, the photos left out, and last the dropped sign. Once
 * the kept sign records the merge, a re-run doesn't recompute its fields; once the dropped sign is
 * gone, `check` says there is nothing to do.
 */
async function mergeSigns(
  deps: OwnerDeps,
  keepSlug: string,
  dropSlug: string,
  mode: OwnerMode,
  options: MergeOptions
): Promise<string[]> {
  const { store, photos } = deps;
  const live = mode === 'live';
  const out: string[] = [];
  const signs = await store.allSigns();
  const keep = signs.find((s) => s.slug === keepSlug) ?? refuse(`No sign with the slug ${keepSlug}`);
  const drop = signs.find((s) => s.slug === dropSlug);
  if (!drop) {
    const held = await store.slugHolder(dropSlug);
    if (held?.movedFrom && held.signId === keep.id)
      return [await describeSign(store, keep), `${dropSlug} was merged into ${keepSlug} already: nothing to do.`];
    return refuse(`No sign with the slug ${dropSlug}`);
  }
  if (drop.id === keep.id) refuse('A sign can’t be merged into itself');
  out.push(`Keep: ${await describeSign(store, keep)}`);
  out.push(`Drop: ${await describeSign(store, drop)}`);

  const record = keep.merged?.find((m) => m.signId === drop.id);
  const at = (deps.now?.() ?? new Date()).toISOString();
  const people = new Map((await store.allPlayers()).map((p) => [p.id, p]));
  const who = (id: string) => named(people.get(id));

  // The kept sign's fields, unless an earlier run wrote them.
  let fields: Parameters<Store['updateSign']>[1] | undefined;
  let fromDrop: Photo[] = [];
  let removed: string[];
  if (record) {
    out.push(
      `A merge started ${record.at} already wrote ${keepSlug}’s photos, caption, dates, place and finders: ${live ? 'finishing' : 'a live run finishes'} the rest.`
    );
    removed = record.photosRemoved;
  } else {
    const picked = pickPhotos(keep, drop, options.photos);
    fromDrop = picked.filter((p) => p.from === 'drop').map((p) => p.photo);
    const kept = new Set(picked.map((p) => p.photo.id));
    removed = [...keep.photos, ...drop.photos].filter((p) => !kept.has(p.id)).map((p) => p.id);
    const caption = mergedCaption(keep, drop, options.caption, options.captionTrim);
    const foundOn = options.foundOn === 'drop' ? drop.foundOn : keep.foundOn;
    const postedAt = options.postedAt === 'drop' ? drop.postedAt : keep.postedAt;
    const place = options.place === 'drop' ? drop.place : keep.place;
    const finders = mergedFinders(keep, drop);
    const merged: MergeRecord = { signId: drop.id, slug: drop.slug, at, photosRemoved: removed };
    fields = {
      photos: picked.map((p) => p.photo),
      caption: caption ?? null,
      foundOn,
      postedAt,
      place,
      finders,
      merged: [...(keep.merged ?? []), merged]
    };
    const change = (label: string, from: string, to: string) =>
      out.push(`${label}: ${from === to ? `${to} (no change)` : `${from} → ${to}`}`);
    out.push(`Photos, in order: ${picked.map(photoLine).join('; ')}`);
    out.push(
      `Photos deleted: ${
        removed.length
          ? [
              ...keep.photos.map((p, i) => ({ p, l: `keep:${i + 1}` })),
              ...drop.photos.map((p, i) => ({ p, l: `drop:${i + 1}` }))
            ]
              .filter(({ p }) => removed.includes(p.id))
              .map(({ p, l }) => `${l} ${p.id}`)
              .join('; ')
          : 'none'
      }`
    );
    if (fromDrop.length)
      out.push(
        `The dropped sign’s photos that stay keep their ids, files and alt text: only ${keepSlug}’s row points at them.`
      );
    change('Found on', keep.foundOn, foundOn);
    change('Posted at', keep.postedAt, postedAt);
    change('Place', where(keep.place), where(place));
    out.push(
      caption === (keep.caption?.trim() || undefined)
        ? 'Caption: no change.'
        : `Caption (${options.caption ?? 'keep'}${options.captionTrim ? ', trimmed' : ''}, ${caption?.length ?? 0} characters): ${caption ? JSON.stringify(caption) : 'none'}`
    );
    out.push(
      `Finders: ${finders.map((f) => (f.playerId ? who(f.playerId) : f.name)).join(', ')}${finders.length === keep.finders.length ? ' (no change)' : ''}`
    );
    if (postedAt !== keep.postedAt)
      out.push(
        `Feeds and lists order signs by when they were posted, so ${keepSlug} moves to ${postedAt.slice(0, 10)} there; its feed item’s id stays ${keepSlug}’s.`
      );
  }

  const ways = await planWays(store, keep, drop);
  for (const w of ways) {
    const line = `Way ${w.way.text} (${w.way.id}) by ${who(w.way.playerId)}`;
    if (w.moved) out.push(`${line}: on ${keepSlug} already; its copy on ${dropSlug} goes.`);
    else if (w.into)
      out.push(
        `${line} is the same way as ${keepSlug}’s ${w.into.text} (${w.into.id}) by ${who(w.into.playerId)}: it goes, and ${
          w.credit.length
            ? `${w.credit.map(who).join(', ')} ${live ? 'are' : 'would be'} credited as found too`
            : 'no one new is credited'
        }.`
      );
    else
      out.push(`${line} ${live ? 'moves' : 'would move'} to ${keepSlug}, with ${plural(w.coFinds.length, 'co-find')}.`);
  }
  if (!ways.length) out.push(`${dropSlug} has no ways.`);

  const hearts = await planHearts(store, keep, drop);
  const moving = hearts.filter((h) => !h.onKeep);
  const kudos = await kudosAt(deps, drop);
  const ours = new Set(hearts.map((h) => h.heart.uid));
  const website = kudos.uids
    ? kudos.uids.filter((u) => !ours.has(u)).length
    : kudos.count === undefined
      ? undefined
      : Math.max(0, kudos.count - hearts.length);
  out.push(
    `Hearts on ${dropSlug}: ${plural(hearts.length, 'player’s heart')} (${moving.length} ${live ? 'move' : 'would move'} to ${keepSlug}, ${hearts.length - moving.length} on both, kept there once); Tinylytics kudos at ${heartPath(drop)}: ${
      kudos.count ?? 'unknown'
    }${kudos.uids ? '' : kudos.count === undefined ? ' (no key and no public count)' : ' (the public count)'}, of them website hearts: ${
      website ?? 'unknown'
    }${website ? `, which ${live ? 'are' : 'would be'} taken back: a website heart has no player to move it for` : ''}.`
  );
  const kudoWork = hearts.length > 0 || kudos.count !== 0;
  out.push(
    kudoWork
      ? `Tinylytics: ${live ? 'needs' : 'a live run needs'} TINYLYTICS_API_KEY for this.`
      : 'Tinylytics: nothing to change, so no key is needed.'
  );

  const { reports, duplicates } = await reportsOn(store, drop);
  out.push(
    `Reports on ${dropSlug}: ${plural(reports, 'report')} and ${plural(duplicates, 'duplicate report')}, removed with it.`
  );
  out.push(
    `Address: /signs/${dropSlug} (the site, Quiz and /api/v1/signs/${dropSlug}) ${live ? 'leads' : 'would lead'} to /signs/${keepSlug} with a 301: its SLUG# row points at ${keepSlug}’s id. Sitemap, feeds, signs.json and share cards list the sign once, as ${keepSlug}.`
  );
  if (!live) return out;
  if (kudoWork && !deps.tinylytics)
    refuse(
      'No Tinylytics key: the dropped sign’s hearts and kudos can’t be moved or taken back, so nothing was changed.'
    );

  await underBothLeases(store, keep, drop, async () => {
    await thenClear(deps, out, async () => {
      // 1. Hearts and kudos, first, as a delete takes them: a failure here leaves both signs whole.
      if (deps.tinylytics) {
        const withKey = { ...deps, tinylytics: deps.tinylytics };
        for (const h of hearts) await moveHeart(withKey, keep, drop, h);
        await removeSignKudos(deps, [drop]);
      }
      // 2. The dropped sign's photos that stay go where the kept sign's are (p/ when it is shown).
      for (const photo of fromDrop) {
        if (keep.visibility === 'shown') await photos.show(photo.id);
        else await photos.hide(photo.id);
      }
      // 3. The kept sign's fields and the record of the merge, in one write.
      if (fields && !(await store.updateSign(keep.id, fields))) refuse('The kept sign is gone');
      // 4. Ways: moved in the store's own transaction, or credited on the same way there.
      for (const w of ways) {
        if (!w.moved && !w.into) {
          const added = await store.addWay({ ...w.way, signId: keep.id });
          if (added !== 'added') refuse(`The way ${w.way.text} couldn’t move (${added}): run it again`);
        }
        const target = w.into ?? (await store.listWays(keep.id)).find((x) => x.id === w.way.id);
        if (target) {
          const players = w.into ? w.credit : w.coFinds.map((c) => c.playerId);
          for (const playerId of players) {
            const earlier = w.coFinds.find((c) => c.playerId === playerId);
            await store.addCoFind(
              {
                signId: keep.id,
                wayId: target.id,
                playerId,
                createdAt: earlier?.createdAt ?? w.way.createdAt,
                via: earlier?.via ?? 'app'
              },
              target
            );
          }
        }
        await store.deleteWay(w.way);
      }
      await settleWays(store, keep.id);
      // 5. The dropped slug leads to the kept sign from now on.
      if (!(await store.moveSlug(drop.slug, drop.id, keep.id)))
        refuse(`The slug ${drop.slug} isn’t ${dropSlug}’s any more`);
      // 6. The photos left out. Never one the kept sign shows.
      const shown = new Set(((await store.getSign(keep.id, true)) ?? keep).photos.map((p) => p.id));
      for (const id of removed) if (!shown.has(id)) await photos.remove(id);
      // 7. The dropped sign, with its reports and anything left under it; its photos stay.
      await store.deleteSign(drop.id);
      await sweepSignKudos(deps, [drop]);
      out.push(`Merged ${dropSlug} into ${keepSlug}.`);
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// set-alt

/** The longest alt text `set-alt` takes: a sentence or two, as the moderator writes them. */
export const ALT_MAX = 300;

type AltEntry = { sign_id: string; photo_id: string; alt: string };

/**
 * `set-alt --file <alts.json>`: photo alt text from a list of `{ sign_id, photo_id, alt }` (other
 * fields are ignored). The whole file is refused, naming the entries, if any sign or photo isn't
 * there or any alt is empty, longer than `ALT_MAX` or has a line break. Without `force`, only an
 * alt that is still the generic `plainAlt(title)` or empty is replaced; the rest are skipped with a
 * note. `live` writes each sign whose alt text changes, its photos field alone (`updateSign`), and
 * clears the edge once.
 */
async function setAlts(deps: OwnerDeps, raw: unknown, mode: OwnerMode, force: boolean): Promise<string[]> {
  const { store } = deps;
  const live = mode === 'live';
  if (!Array.isArray(raw)) return refuse('The file is a JSON list of { "sign_id", "photo_id", "alt" }');
  const signs = new Map((await store.allSigns()).map((s) => [s.id, s]));
  const problems: string[] = [];
  const entries: (AltEntry & { n: number })[] = [];
  raw.forEach((item, i) => {
    const n = i + 1;
    const e = (item ?? {}) as Record<string, unknown>;
    const sign = typeof e.sign_id === 'string' ? signs.get(e.sign_id) : undefined;
    const alt = typeof e.alt === 'string' ? e.alt.trim() : '';
    const label = `#${n} (${String(e.sign_id)} / ${String(e.photo_id)})`;
    if (!sign) problems.push(`${label}: no such sign`);
    else if (!sign.photos.some((p) => p.id === e.photo_id)) problems.push(`${label}: ${sign.slug} has no such photo`);
    if (!alt) problems.push(`${label}: the alt text is empty`);
    else if (alt.length > ALT_MAX) problems.push(`${label}: the alt text is ${alt.length} characters, over ${ALT_MAX}`);
    else if (/[\r\n\u2028\u2029]/.test(alt)) problems.push(`${label}: the alt text has a line break`);
    if (entries.some((x) => x.sign_id === e.sign_id && x.photo_id === e.photo_id))
      problems.push(`${label}: that photo is in the file twice`);
    entries.push({ n, sign_id: String(e.sign_id), photo_id: String(e.photo_id), alt });
  });
  if (problems.length) refuse(`Nothing was changed. The file has problems:\n${problems.join('\n')}`);

  const out: string[] = [];
  const changes = new Map<string, Map<string, string>>();
  for (const e of entries) {
    const sign = signs.get(e.sign_id)!;
    const old = sign.photos.find((p) => p.id === e.photo_id)!.alt;
    const generic = !old.trim() || old === plainAlt(sign.title);
    const head = `${sign.slug} ${e.photo_id}`;
    if (old === e.alt) {
      out.push(`${head}: unchanged “${old}”`);
      continue;
    }
    if (!generic && !force) {
      out.push(`${head}: skipped, it already has its own alt text (--force replaces it): “${old}” (not “${e.alt}”)`);
      continue;
    }
    out.push(`${head}: “${old}” → “${e.alt}”`);
    const byPhoto = changes.get(sign.id) ?? new Map<string, string>();
    byPhoto.set(e.photo_id, e.alt);
    changes.set(sign.id, byPhoto);
  }
  const count = [...changes.values()].reduce((n, m) => n + m.size, 0);
  out.push(`${live ? 'Writing' : 'Would write'} ${plural(count, 'alt text')} on ${plural(changes.size, 'sign')}.`);
  if (!live || !changes.size) return out;
  await thenClear(deps, out, async () => {
    for (const [signId, byPhoto] of changes) {
      // Read again just before the write, so only the alt text of the photos named changes.
      const fresh = (await store.getSign(signId, true)) ?? refuse(`The sign ${signId} is gone`);
      const photos = fresh.photos.map((p) => (byPhoto.has(p.id) ? { ...p, alt: byPhoto.get(p.id)! } : p));
      if (!(await store.updateSign(signId, { photos }))) refuse(`The sign ${signId} is gone`);
    }
    out.push('Written.');
  });
  return out;
}
