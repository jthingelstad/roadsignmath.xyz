// What a signed-in player can make: photos, signs, ways, reports and blocks. Every post and
// report goes past the moderator (src/moderation/); everything else is checked here.

import { fail } from '../api/errors.ts';
import { limit, text } from '../api/input.ts';
import { LIMITS } from '../api/contract.ts';
import { check, normalizeNumber, numbersNotOnSign } from '../domain/equation.ts';
import { slugify, ulid } from '../domain/ids.ts';
import type { Finder, FinderRole, Photo, Place, Player, Report, Sign, SignNumber, Way } from '../domain/types.ts';
import { ModeratorUnavailable, plainAlt, type Moderator, type Post } from '../moderation/moderator.ts';
import { removeSignKudos, sweepSignKudos } from '../hearts.ts';
import { renditions, type PhotoStore } from '../photos.ts';
import type { Tinylytics } from '../tinylytics.ts';
import { nowSeconds, type Store } from '../store/store.ts';

export type PostingDeps = { store: Store; photos: PhotoStore; moderator: Moderator; tinylytics?: Tinylytics };

const DAY = 86400;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ROLES: FinderRole[] = ['found', 'took_photo', 'spotted'];
const NUMBER = /^\d*\.?\d+$|^\d+\.$/;
/** Slugs a sign can't have, because a route under /signs/ already uses the word. */
const RESERVED_SLUGS = new Set(['near', 'similar']);

const tomorrow = 'Try again tomorrow.';
const isoNow = (now: number): string => new Date(now * 1000).toISOString();

function needName(player: Player): void {
  if (!player.name) fail('bad_request', 'Give your name first');
}

export async function moderate<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    if (err instanceof ModeratorUnavailable) {
      console.error('moderator unavailable:', err.message);
      return fail('unavailable', 'Our moderator couldn’t look just now. Try again in a minute.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Photos

/** A photo sent as a request's raw body, refused when it isn't a kind we take or is too big. */
export async function readPhoto(
  type: string | undefined,
  body: () => Promise<ArrayBuffer>,
  length: number | undefined
): Promise<Buffer> {
  const media = (type ?? '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_TYPES.includes(media)) fail('bad_request', 'Send a JPEG, PNG or WebP photo');
  const tooLarge = `A photo can be at most ${LIMITS.photoBytes / 1024 / 1024} MB`;
  if (length !== undefined && length > LIMITS.photoBytes) fail('too_large', tooLarge);
  const bytes = Buffer.from(await body());
  if (bytes.length > LIMITS.photoBytes) fail('too_large', tooLarge);
  if (!bytes.length) fail('bad_request', 'The photo is empty');
  return bytes;
}

/** Keeps an uploaded photo, at both sizes and without its metadata, until it is posted. */
export async function uploadPhoto(
  { store, photos }: PostingDeps,
  player: Player,
  type: string | undefined,
  body: () => Promise<ArrayBuffer>,
  length: number | undefined
): Promise<{ id: string; width: number; height: number }> {
  const bytes = await readPhoto(type, body, length);
  const now = nowSeconds();
  await limit(store, `uploads:${player.id}`, LIMITS.uploadsADay, DAY, now, `Too many photos today. ${tomorrow}`);
  const sized = await renditions(bytes).catch(() => fail('bad_request', 'That photo couldn’t be read'));
  const id = ulid().toLowerCase();
  await photos.putUpload(id, sized);
  await store.putUpload({
    playerId: player.id,
    photoId: id,
    width: sized.width,
    height: sized.height,
    createdAt: isoNow(now),
    expiresAt: now + LIMITS.uploadTtl
  });
  return { id, width: sized.width, height: sized.height };
}

// ---------------------------------------------------------------------------------------------
// Reading a post

type PostInput = {
  photoIds: string[];
  title: string;
  caption?: string;
  numbers: SignNumber[];
  place: Place;
  foundOn: string;
  finders?: { handle?: string; name?: string; role: FinderRole }[];
  way?: string;
};

function object(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad_request', `${field} must be an object`);
  return raw as Record<string, unknown>;
}

function list(raw: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    return fail('bad_request', `${field} must be a list of ${min} to ${max}`);
  }
  return raw;
}

function only(body: Record<string, unknown>, field: string, allowed: string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) fail('bad_request', `${field} has no ${unknown.join(', ')}`);
}

const absent = (value: unknown): boolean => value === undefined || value === null;

function number(raw: unknown, i: number): SignNumber {
  const field = `numbers[${i}]`;
  const n = object(raw, field);
  only(n, field, ['value', 'text', 'why', 'box']);
  if (typeof n.value !== 'string' || !NUMBER.test(n.value)) {
    return fail('bad_request', `${field}.value must be a plain number, like "7" or "1.5"`);
  }
  const out: SignNumber = { value: normalizeNumber(n.value) };
  if (!absent(n.text)) out.text = text(n.text, `${field}.text`, 40, 1);
  if (!absent(n.why)) out.why = text(n.why, `${field}.why`, 60, 1);
  if (!absent(n.box)) {
    const box = list(n.box, `${field}.box`, 4, 4);
    if (!box.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
      fail('bad_request', `${field}.box holds four fractions from 0 to 1`);
    }
    const [x, y, w, h] = box as number[];
    if (x + w > 1.001 || y + h > 1.001) fail('bad_request', `${field}.box goes past the edge of the photo`);
    out.box = [x, y, w, h];
  }
  return out;
}

function place(raw: unknown): Place {
  const p = object(raw, 'place');
  only(p, 'place', ['label', 'state', 'lat', 'lng', 'approximate']);
  const out: Place = { label: text(p.label, 'place.label', LIMITS.placeMax, 1), approximate: false };
  if (!absent(p.state)) {
    if (typeof p.state !== 'string' || !/^[A-Z]{2}$/.test(p.state)) {
      fail('bad_request', 'place.state is a two-letter state, like "MN"');
    }
    out.state = p.state as string;
  }
  if (absent(p.lat) !== absent(p.lng)) fail('bad_request', 'place needs both lat and lng, or neither');
  if (!absent(p.lat)) {
    const lat = p.lat as number;
    const lng = p.lng as number;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      fail('bad_request', 'place.lat is from -90 to 90');
    }
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      fail('bad_request', 'place.lng is from -180 to 180');
    }
    out.lat = lat;
    out.lng = lng;
  }
  if (!absent(p.approximate)) {
    if (typeof p.approximate !== 'boolean') fail('bad_request', 'place.approximate is true or false');
    out.approximate = p.approximate as boolean;
  }
  return out;
}

function foundOn(raw: unknown, now: number): string {
  const bad = 'found_on is a date like 2026-07-04, no later than today';
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail('bad_request', bad);
  const day = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== raw) return fail('bad_request', bad);
  // A day ahead of UTC still counts as today somewhere.
  if (day > (now + DAY) * 1000 || raw < '2000-01-01') fail('bad_request', bad);
  return raw;
}

function readPost(body: Record<string, unknown>, now: number): PostInput {
  only(body, 'The post', ['photo_ids', 'title', 'caption', 'numbers', 'place', 'found_on', 'finders', 'way']);
  const photoIds = list(body.photo_ids, 'photo_ids', 1, LIMITS.photosMax);
  if (!photoIds.every((id) => typeof id === 'string' && /^[0-9a-z]{26}$/.test(id))) {
    fail('bad_request', 'photo_ids holds the ids uploads gave back');
  }
  if (new Set(photoIds).size !== photoIds.length) fail('bad_request', 'photo_ids has the same photo twice');
  const input: PostInput = {
    photoIds: photoIds as string[],
    title: text(body.title, 'title', LIMITS.titleMax, 1),
    numbers: list(body.numbers, 'numbers', 1, LIMITS.numbersMax).map(number),
    place: place(body.place),
    foundOn: foundOn(body.found_on, now)
  };
  if (!absent(body.caption)) input.caption = text(body.caption, 'caption', LIMITS.captionMax, 0) || undefined;
  if (!absent(body.finders)) {
    input.finders = list(body.finders, 'finders', 1, LIMITS.findersMax).map((raw, i) => {
      const field = `finders[${i}]`;
      const f = object(raw, field);
      only(f, field, ['handle', 'name', 'role']);
      const role = (f.role ?? 'found') as FinderRole;
      if (!ROLES.includes(role)) fail('bad_request', `${field}.role is one of ${ROLES.join(', ')}`);
      if (absent(f.handle) === absent(f.name)) fail('bad_request', `${field} has a handle or a name, not both`);
      if (!absent(f.handle)) {
        if (typeof f.handle !== 'string') fail('bad_request', `${field}.handle must be text`);
        return { handle: f.handle as string, role };
      }
      return { name: text(f.name, `${field}.name`, 40, 1), role };
    });
  }
  if (!absent(body.way)) {
    if (typeof body.way !== 'string' || body.way.length > LIMITS.wayMax) {
      fail('bad_request', `way is math text of at most ${LIMITS.wayMax} characters`);
    }
    input.way = body.way as string;
  }
  return input;
}

/** The finders as stored: players by id with their names, and plain names. */
async function finders(store: Store, poster: Player, input: PostInput): Promise<Finder[]> {
  if (!input.finders) return [{ playerId: poster.id, name: poster.name, role: 'found' }];
  const players = new Map((await store.allPlayers()).filter((p) => p.name).map((p) => [p.handle, p]));
  const seen = new Set<string>();
  return input.finders.map((f) => {
    if (f.name) return { name: f.name, role: f.role };
    const player = players.get(f.handle!) ?? fail('bad_request', `No player is called ${f.handle}`);
    if (seen.has(player.id)) fail('bad_request', `${f.handle} is in finders twice`);
    seen.add(player.id);
    return { playerId: player.id, name: player.name, role: f.role };
  });
}

/** Checks a way against the sign's numbers: true math, and only numbers the sign shows. */
function checkWay(raw: string, numbers: SignNumber[]): { text: string; value: string; numbers: string[] } {
  const result = check(raw);
  if (!result.ok) return fail('bad_request', result.message);
  const missing = numbersNotOnSign(
    result.numbers,
    numbers.map((n) => n.value)
  );
  if (missing.length) {
    fail('bad_request', `${missing.join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} on the sign that often`);
  }
  return { text: result.canonical, value: result.value, numbers: result.numbers };
}

/** The first free slug from the title: title, title-2, title-3… claimed so two posts can't share one. */
async function reserveSlug(store: Store, signId: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set((await store.allSigns()).map((s) => s.slug));
  for (let n = 1; n <= 200; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (RESERVED_SLUGS.has(slug) || taken.has(slug)) continue;
    if (await store.claimSlug(slug, signId)) return slug;
  }
  const slug = `${base}-${signId.slice(-8).toLowerCase()}`;
  if (!(await store.claimSlug(slug, signId))) fail('internal', 'Try posting again');
  return slug;
}

// ---------------------------------------------------------------------------------------------
// Posting

/**
 * Posts a sign from the player's uploads. With an Idempotency-Key, the same post sent twice
 * makes one sign; the second answer is the first sign.
 */
export async function postSign(
  deps: PostingDeps,
  player: Player,
  body: Record<string, unknown>,
  key: string | undefined
): Promise<{ sign: Sign; ways: Way[] }> {
  const { store, photos, moderator } = deps;
  needName(player);
  const now = nowSeconds();
  const input = readPost(body, now);
  const way = input.way === undefined ? undefined : checkWay(input.way, input.numbers);
  const credited = await finders(store, player, input);

  const id = ulid(now * 1000);
  if (key !== undefined) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail('bad_request', 'Idempotency-Key is 8 to 128 letters, digits, - or _');
    const held = await store.claimPost(player.id, key, id, LIMITS.uploadTtl);
    if (held) {
      const earlier = await store.getSign(held);
      if (earlier?.postedBy === player.id) return { sign: earlier, ways: await store.listWays(earlier.id) };
      fail('conflict', 'That post is still being made. Try again in a moment.');
    }
  }
  // What this post has done so far, undone if it fails, so the same post can be sent again.
  const taken: string[] = [];
  const published: string[] = [];
  let slug: string | undefined;
  let written = false;
  try {
    await limit(store, `posts:${player.id}`, LIMITS.postsADay, DAY, now, `Too many posts today. ${tomorrow}`);
    const notYours = (photoId: string) => `Photo ${photoId} isn’t one of your uploads, or it waited too long`;
    const uploads = [];
    for (const photoId of input.photoIds) {
      const upload = (await store.getUpload(player.id, photoId)) ?? fail('bad_request', notYours(photoId));
      // Taken for this sign alone, so a second post at once can't share (and later delete) it.
      if (!(await store.claimUpload(player.id, photoId, id))) {
        fail('conflict', `Photo ${photoId} is already in another post`);
      }
      taken.push(photoId);
      const large = (await photos.get(photoId, 'large', 'upload')) ?? fail('bad_request', notYours(photoId));
      uploads.push({ upload, large });
    }

    const post: Post = {
      title: input.title,
      caption: input.caption,
      numbers: input.numbers.map((n) => n.value),
      photos: uploads.map((u) => u.large)
    };
    const verdict = await moderate(() => moderator.reviewPost(post));

    slug = await reserveSlug(store, id, input.title);
    // A held post's photos never reach the public p/ folder.
    const place = verdict.verdict === 'hold' ? 'held' : 'shown';
    for (const { upload } of uploads) {
      published.push(upload.photoId);
      await photos.publish(upload.photoId, place);
    }
    const signPhotos: Photo[] = uploads.map(({ upload }, i) => ({
      id: upload.photoId,
      width: upload.width,
      height: upload.height,
      alt: verdict.alt[i]?.trim() || plainAlt(input.title)
    }));
    const at = isoNow(now);
    const sign: Sign = {
      id,
      slug,
      title: input.title,
      photos: signPhotos,
      numbers: input.numbers,
      place: input.place,
      foundOn: input.foundOn,
      postedAt: at,
      postedBy: player.id,
      finders: credited,
      visibility: verdict.verdict === 'hold' ? 'held' : 'shown',
      wayCount: way ? 1 : 0
    };
    if (input.caption) sign.caption = input.caption;
    if (verdict.verdict === 'hold') {
      sign.moderation = { note: verdict.reason || 'Our moderator held this post.', at };
    }
    const ways: Way[] = [];
    if (way) {
      sign.firstWay = { text: way.text, value: way.value, playerId: player.id };
      ways.push({ id: ulid(now * 1000), signId: id, playerId: player.id, ...way, createdAt: at });
    }
    // The first way is in before the sign is, so no one can add the same math to it in between.
    written = true;
    for (const w of ways) {
      await store.claimWay(id, w.text, w.id);
      await store.putWay(w);
    }
    await store.putSign(sign);
    // The post is made. Its uploads are taken for it, so another post can't use them, and they
    // expire on their own if clearing them fails here.
    for (const photoId of taken) await store.deleteUpload(player.id, photoId).catch(() => undefined);
    return { sign, ways };
  } catch (err) {
    const undo = [
      ...(written ? [() => store.deleteSign(id)] : []),
      ...(slug !== undefined ? [() => store.releaseSlug(slug!, id)] : []),
      ...published.map((photoId) => () => photos.unpublish(photoId)),
      ...taken.map((photoId) => () => store.releaseUpload(player.id, photoId, id)),
      ...(key !== undefined ? [() => store.releasePost(player.id, key)] : [])
    ];
    // Each step is tried even if one before it fails; the post's own error is what the player sees.
    for (const step of undo) await step().catch(() => undefined);
    throw err;
  }
}

/** Removes a sign the player posted, with its hearts, its photos and every way on it. */
export async function deleteSign(deps: PostingDeps, player: Player, sign: Sign): Promise<void> {
  const { store, photos } = deps;
  if (sign.postedBy !== player.id) fail('not_found', 'No sign of yours by that id');
  // Its hearts first: if Tinylytics can't remove them, the sign is still whole to delete again.
  await removeSignKudos(deps, [sign]);
  // The photos go first: if one can't be removed, the sign is still there to delete again.
  for (const photo of sign.photos) await photos.remove(photo.id);
  await store.deleteSign(sign.id);
  await sweepSignKudos(deps, [sign]);
}

/** Adds a way to a sign, keeping the sign's count and first way in step with its ways. */
export async function addWay(
  { store }: PostingDeps,
  player: Player,
  sign: Sign,
  body: Record<string, unknown>
): Promise<Way[]> {
  needName(player);
  only(body, 'The way', ['text']);
  if (typeof body.text !== 'string' || body.text.length > LIMITS.wayMax) {
    fail('bad_request', `text is math of at most ${LIMITS.wayMax} characters`);
  }
  const way = checkWay(body.text as string, sign.numbers);
  const taken = 'Someone already found that way';
  if ((await store.listWays(sign.id)).some((w) => w.text === way.text)) fail('conflict', taken);
  const now = nowSeconds();
  await limit(store, `ways:${player.id}`, LIMITS.waysADay, DAY, now, `Too many ways today. ${tomorrow}`);
  // The check above answers most repeats; this one write settles two of the same way sent at once.
  // Its time and id are to the millisecond, so ways keep the order they were sent in.
  const ms = Date.now();
  const added = await store.addWay({
    id: ulid(ms),
    signId: sign.id,
    playerId: player.id,
    ...way,
    createdAt: new Date(ms).toISOString()
  });
  if (added === 'taken') fail('conflict', taken);
  if (added === 'gone') fail('not_found', 'No sign by that id');
  return store.listWays(sign.id);
}

/** Sends a sign back to the moderator with the player's reason; it is hidden if the moderator agrees. */
export async function reportSign(
  { store, photos, moderator }: PostingDeps,
  player: Player,
  sign: Sign,
  body: Record<string, unknown>
): Promise<Report> {
  if (sign.postedBy === player.id) fail('bad_request', 'You can’t report your own sign');
  only(body, 'The report', ['reason']);
  const reason = text(body.reason, 'reason', LIMITS.reportMax, 1);
  const earlier = await store.getReport(sign.id, player.id);
  if (earlier) return earlier;
  const now = nowSeconds();
  await limit(store, `reports:${player.id}`, LIMITS.reportsADay, DAY, now, `Too many reports today. ${tomorrow}`);
  // One report at a time on a sign, so one hiding its photos and another keeping them can't cross.
  const lease = `report:${sign.id}`;
  if (!(await store.lease(lease, player.id, 120))) {
    fail('conflict', 'Someone else’s report of this sign is being looked at. Try again in a minute.');
  }
  try {
    return await judgeReport({ store, photos, moderator }, player, (await store.getSign(sign.id)) ?? sign, reason, now);
  } finally {
    await store.endLease(lease, player.id).catch(() => undefined);
  }
}

/** The moderator's look at a reported sign, read fresh under the sign's report lease. */
async function judgeReport(
  { store, photos, moderator }: PostingDeps,
  player: Player,
  sign: Sign,
  reason: string,
  now: number
): Promise<Report> {
  // Each photo is read from wherever it is: a hide that failed partway can have moved some of a
  // shown sign's photo files to held/ already, and the moderator should see them all.
  const larges: Buffer[] = [];
  const expected = sign.visibility === 'shown' ? 'shown' : 'held';
  for (const photo of sign.photos) {
    let large = await photos.get(photo.id, 'large', expected);
    if (!large && expected === 'shown') large = await photos.get(photo.id, 'large', 'held');
    if (large) larges.push(large);
  }
  const post: Post = {
    title: sign.title,
    caption: sign.caption,
    numbers: sign.numbers.map((n) => n.value),
    photos: larges
  };
  const verdict = await moderate(() => moderator.reviewReport(post, reason));
  const at = isoNow(now);
  const report: Report = {
    signId: sign.id,
    playerId: player.id,
    reason,
    outcome: verdict.verdict === 'hide' ? 'hidden' : 'kept',
    note: verdict.reason || (verdict.verdict === 'hide' ? 'Our moderator hid this post.' : 'Our moderator kept it.'),
    createdAt: at
  };
  // Photos first, then the sign, then the report: a report that fails partway is not saved, so
  // the player's next try runs it again, and hiding a photo twice is harmless.
  if (report.outcome === 'hidden') {
    for (const photo of sign.photos) await photos.hide(photo.id);
    await store.updateSign(sign.id, { visibility: 'hidden', moderation: { note: report.note, at } });
  } else if (sign.visibility === 'shown') {
    // Kept: every file a failed hide left under held/ goes back (show moves only what is there).
    for (const photo of sign.photos) await photos.show(photo.id);
  }
  await store.putReport(report);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Blocks

async function playerByHandle(store: Store, handle: string): Promise<Player> {
  const player = (await store.allPlayers()).find((p) => p.handle === handle);
  return player ?? fail('not_found', 'No player by that handle');
}

export async function blockPlayer(store: Store, player: Player, handle: string): Promise<void> {
  const other = await playerByHandle(store, handle);
  if (other.id === player.id) fail('bad_request', 'You can’t block yourself');
  await store.putBlock({ playerId: player.id, blockedId: other.id, createdAt: isoNow(nowSeconds()) });
}

export async function unblockPlayer(store: Store, player: Player, handle: string): Promise<void> {
  const other = await playerByHandle(store, handle);
  await store.deleteBlock(player.id, other.id);
}
