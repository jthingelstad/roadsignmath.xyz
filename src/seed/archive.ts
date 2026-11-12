// The first era (roadsignmath.com, 2005-2014) as signs in today's game. A sign comes over only
// with a photo and at least one way today's checker accepts. Everything here is pure except
// `loadArchive`, which writes a plan to a store; the archive itself stays outside this repo.
//
// A sign's dates are the point of this file: `postedAt` and the first way's `createdAt` are the
// old post's own time, and `foundOn` the day the photo was taken as best the record shows.

import { LIMITS } from '../api/contract.ts';
import { check, normalizeNumber, numbersNotOnSign } from '../domain/equation.ts';
import { STATES } from '../domain/geo.ts';
import { slugify, ulidFrom, uniqueSlug } from '../domain/ids.ts';
import { AVATAR_COLORS, type Place, type Player, type Sign, type Way } from '../domain/types.ts';
import { renditions, type PhotoStore } from '../photos.ts';
import { addSign, mergedAway, normalizeEmail, type Store } from '../store/store.ts';

/** One `signs/*.md` file of the archive: its name without `.md`, front matter and text. */
export type ArchivePost = { stem: string; meta: ArchiveMeta; body: string };

export type ArchiveMeta = {
  title: string;
  found_by: string;
  found_by_user?: string;
  numbers?: unknown[];
  math?: unknown[];
  solutions?: { by?: string; math: unknown }[];
  location?: { city?: string; state?: string; country?: string; coordinates?: unknown[] };
  photos?: { file: string; image?: string }[];
};

/** What the archive's files don't say: `seed/archive.json`. */
export type ArchiveSeed = {
  /** Sign stem to its dates, worked out from the old site's database and the photos. */
  dates: Record<string, { posted_at: string; found_on: string }>;
  /** Sign stem to a correction of what the archive recorded. */
  fixes: Record<
    string,
    {
      way?: string;
      numbers?: string[];
      coordinates?: [number, number];
      /** Where the sign is, when the archive named the wrong place. */
      label?: string;
      approximate?: boolean;
      /** The caption to use instead of the post's own words; null for none. */
      caption?: string | null;
    }
  >;
  /** Finder name to the handle of a player who is already in the game. */
  existing: Record<string, string>;
  /** A photo in the archive to the better copy to load instead, both under its images folder. */
  photo_swaps: Record<string, string>;
};

/** Why a sign stays in the archive. A sign comes over only with none of these (Jamie, 2026-11-07). */
export type LeftOut = 'no photo' | 'no way the checker accepts' | 'no coordinates';

/** A player the plan needs. `existingHandle` means use that player, not a new one. */
export type PlannedPlayer = { player: Player; keys: string[]; existingHandle?: string };

export type ArchivePlan = {
  players: PlannedPlayer[];
  signs: Sign[];
  ways: Way[];
  photos: { id: string; signId: string; source: string }[];
  /** Signs that stay in the archive, and every reason why. */
  left: { title: string; why: LeftOut[] }[];
};

/** Formulas today's checker has no way to read, so they are left out rather than guessed at. */
const UNSUPPORTED =
  /(\\pi\b|\\phi|\\sum|\\prod|\\int|\\sin|\\cos|\\tan|\\arctan|\\sec|\\log|\\ln|\\mod|\\bmod|\\pmod|\\equiv|\\approx|\\neq?|\\begin|\\binom|\\lfloor|\\lceil|\\ldots|\\cdots|\\dots|\\infty|\\lim|\\%|%|\\sqrt\[|\\le|\\ge|<|>|\\Rightarrow|\\rightarrow|\\to\b|\\mid|\||\\overline|\\bar|\\choose|\\circ|\\degree)/;

/** The old site's LaTeX as the text a player would type, or undefined when it can't be. */
export function latexToWay(tex: string): string | undefined {
  let s = tex
    .trim()
    .replace(/\\bigl|\\bigr|\\Bigl|\\Bigr|\\big|\\Big|\\left|\\right|\\,|\\;|\\:|\\!|\\ |~/g, ' ')
    .replace(/\\displaystyle|\\textstyle/g, ' ')
    .replace(/\\mathrm\{([^{}]*)\}/g, '$1')
    .replace(/\\text\{([^{}]*)\}/g, '$1');
  if (UNSUPPORTED.test(s)) return undefined;
  let previous = '';
  while (previous !== s) {
    previous = s;
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1) ÷ ($2))')
      .replace(/\{([^{}]*)\\over([^{}]*)\}/g, '(($1) ÷ ($2))')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
      .replace(/\^\s*\{([^{}]*)\}/g, '^($1)')
      // A bare group, but never a fraction's, root's or power's own argument: those wait
      // until what is inside them has converted and the rules above can read them.
      .replace(/(?<!(?:\\[dt]?frac|\\sqrt|\^|\})\s*)\{([^{}]*)\}/g, '($1)');
  }
  s = s
    .replace(/\\times|\\cdot|\\ast/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\sqrt\s*(\d+)/g, '√$1')
    .replace(/\\sqrt/g, '√')
    .replace(/\\pm/g, '±')
    .replace(/,(?=\d{3}\b)/g, '');
  if (/\\[a-zA-Z]+|[a-df-wyzA-Z_±]/.test(s)) return undefined;
  return s.replace(/\s+/g, ' ').trim();
}

/** A checked equation's shape with its grouping taken out, to compare two ways of writing it. */
function shapeOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node === null || typeof node !== 'object') return node;
  const fields = node as Record<string, unknown>;
  if (fields.op === 'group') return shapeOf(fields.arg);
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, shapeOf(v)]));
}

/** Takes out every pair of parentheses the math doesn't need; `√(16) = 4` becomes `√16 = 4`. */
export function tidyWay(text: string): string {
  const first = check(text);
  if (!first.ok) return text;
  const wanted = JSON.stringify(shapeOf(first.sides));
  let current = first.canonical;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== '(') continue;
    let depth = 0;
    let close = i;
    for (; close < current.length; close++) {
      if (current[close] === '(') depth++;
      if (current[close] === ')' && --depth === 0) break;
    }
    const without = current.slice(0, i) + current.slice(i + 1, close) + current.slice(close + 1);
    const result = check(without);
    if (result.ok && JSON.stringify(shapeOf(result.sides)) === wanted) {
      current = result.canonical;
      i = -1;
    }
  }
  return current;
}

/** Old scoring and contest talk. Today's game has no points, so these lines stay behind. */
const SCORING = /\bpoints?\b|\bscor(e|es|ed|ing)\b|\bpenalt(y|ies)\b|\bsign of the week\b/i;

/** Where a sentence ends, unless it's a title or an initial: "Mr. Brennan", "Henry F. Amiel". */
const SENTENCE = /(?<!\b(?:Mr|Mrs|Ms|Dr|St|Rt|Mt|vs|[A-Z])\.)(?<=[.!?]["”’)]?)\s+(?=["“‘'(]?[A-Z0-9])/;

/**
 * The old post's own words for the caption: its text in order, without photos, formulas,
 * markup, scoring or link targets, whole sentences only, up to the caption limit.
 */
export function captionOf(body: string): string | undefined {
  const paragraphs = body
    .replace(/\$\$[\s\S]*?\$\$/g, '\n\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '\n\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>[ \t]?/gm, '')
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/\$([^$\n]+)\$/g, (_, tex: string) => latexToWay(tex) ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*|__|(?<![\w*])\*|\*(?![\w*])/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p && !p.startsWith('#') && !p.endsWith(':') && !SCORING.test(p));
  let caption = '';
  for (const sentence of paragraphs.flatMap((p) => p.split(SENTENCE))) {
    const next = caption ? `${caption} ${sentence}` : sentence;
    if (next.length > LIMITS.captionMax) break;
    // The old site's imports cut some posts off in mid-sentence; those stumps stay behind.
    if (/[.!?]["”’)*]*$/.test(sentence)) caption = next;
    // An epigraph has no full stop of its own, and the next sentence would run into it.
    else if (/^["“].*["”] -- /.test(sentence)) caption = `${next}.`;
  }
  return caption || undefined;
}

const STATE_CODES = new Map(Object.entries(STATES).map(([code, name]) => [name, code]));
STATE_CODES.set('Washington, D.C.', 'DC');

function placeOf(post: ArchivePost, fix: ArchiveSeed['fixes'][string] | undefined): Place {
  const { city, state, country, coordinates } = post.meta.location ?? {};
  const region = state && state !== 'None' ? state : undefined;
  const label =
    [city, region, country && country !== 'United States' ? country : undefined].filter(Boolean).join(', ') ||
    post.meta.title;
  const code = !country || country === 'United States' ? STATE_CODES.get(region ?? '') : undefined;
  const [lat, lng] = fix?.coordinates ?? coordinates ?? [];
  return {
    label: fix?.label ?? label,
    ...(code ? { state: code } : {}),
    ...(typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : {}),
    approximate: fix?.approximate ?? false
  };
}

const centralDay = (time: number): string =>
  new Date(time).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/** Every player id starts from this time, so a later batch that adds an older sign finds the same id. */
const PLAYER_EPOCH = Date.parse('2005-02-13T00:00:00Z');

/** Whether the player came from the 2005-2014 archive: their id carries PLAYER_EPOCH's time. */
export const isFirstEraPlayer = (id: string): boolean => id.slice(0, 10) === ulidFrom(PLAYER_EPOCH, '').slice(0, 10);

/** Turns the archive into signs, ways and players. Throws one error listing every problem. */
export function buildArchivePlan(posts: ArchivePost[], seed: ArchiveSeed): ArchivePlan {
  const problems: string[] = [];
  const left: ArchivePlan['left'] = [];
  const players = new Map<string, PlannedPlayer>();
  const handles = new Set<string>();
  const slugs = new Set<string>();
  const signs: Sign[] = [];
  const ways: Way[] = [];
  const photos: ArchivePlan['photos'] = [];

  const playerFor = (name: string, at: string, username?: string): PlannedPlayer => {
    let planned = players.get(name);
    if (!planned) {
      const existingHandle = seed.existing[name];
      const handle = existingHandle ?? uniqueSlug(slugify(name), (h) => handles.has(h));
      handles.add(handle);
      planned = {
        player: {
          id: ulidFrom(PLAYER_EPOCH, `archive-player:${name}`),
          handle,
          name,
          avatarColor: AVATAR_COLORS[players.size % AVATAR_COLORS.length],
          createdAt: at
        },
        keys: [name.toLowerCase()],
        ...(existingHandle ? { existingHandle } : {})
      };
      players.set(name, planned);
    }
    if (username && !planned.keys.includes(username.toLowerCase())) planned.keys.push(username.toLowerCase());
    return planned;
  };

  // Oldest first, so a player's first sign sets when they joined and old names win their slugs.
  const when = (post: ArchivePost): string => seed.dates[post.stem]?.posted_at ?? '';
  const ordered = [...posts].sort((a, b) => when(a).localeCompare(when(b)) || a.stem.localeCompare(b.stem));

  for (const post of ordered) {
    const { meta, stem } = post;
    const fix = seed.fixes[stem];
    const dates = seed.dates[stem];
    const numbers = (fix?.numbers ?? (meta.numbers ?? []).map(String))
      .filter((n) => /^\d*\.?\d+$/.test(n))
      .map(normalizeNumber);

    // The named solutions first, then the formulas in the text, as the old page ran them.
    const candidates: { text?: string; by?: string }[] = [
      ...(fix?.way ? [{ text: fix.way }] : []),
      ...(meta.solutions ?? []).map((s) => ({ text: latexToWay(String(s.math)), by: s.by })),
      ...(meta.math ?? []).map((m) => ({ text: latexToWay(String(m)) }))
    ];
    const accepted = new Map<string, { value: string; numbers: string[]; by?: string }>();
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const text = tidyWay(candidate.text);
      const result = check(text);
      if (!result.ok || numbersNotOnSign(result.numbers, numbers).length) continue;
      if (!accepted.has(result.canonical)) {
        accepted.set(result.canonical, { value: result.value, numbers: result.numbers, by: candidate.by });
      }
    }
    const images = (meta.photos ?? []).filter((p) => p.image);
    // A real photo, coordinates and math today's game reads. Coordinates on a town's center count:
    // "If you have a coordinates, that's what we need" (Jamie, 2026-11-07).
    const place = placeOf(post, fix);
    const why: LeftOut[] = [
      ...(images.length ? [] : ['no photo' as const]),
      ...(accepted.size ? [] : ['no way the checker accepts' as const]),
      ...(place.lat !== undefined ? [] : ['no coordinates' as const])
    ];
    if (why.length) {
      left.push({ title: meta.title, why });
      continue;
    }

    if (!dates) {
      problems.push(`${meta.title}: no dates`);
      continue;
    }
    const time = Date.parse(dates.posted_at);
    if (Number.isNaN(time)) {
      problems.push(`${meta.title}: posted_at ${dates.posted_at} isn't a time`);
      continue;
    }
    const postedAt = new Date(time).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dates.found_on)) problems.push(`${meta.title}: found_on ${dates.found_on}`);
    if (dates.found_on > centralDay(time)) problems.push(`${meta.title}: found ${dates.found_on}, after its post`);
    if (meta.title.length > LIMITS.titleMax) problems.push(`${meta.title}: title too long`);
    if (numbers.length > LIMITS.numbersMax) problems.push(`${meta.title}: ${numbers.length} numbers`);

    const id = ulidFrom(time, `archive:${stem}`);
    const finder = playerFor(meta.found_by, postedAt, meta.found_by_user).player;
    const signWays: Way[] = [...accepted].map(([text, way], i) => ({
      id: ulidFrom(time + i, `archive-way:${stem}:${text}`),
      signId: id,
      playerId: way.by ? playerFor(way.by, postedAt).player.id : finder.id,
      text,
      value: way.value,
      numbers: way.numbers,
      // The first way is the post itself: it has to carry the post's own time.
      createdAt: new Date(time + i).toISOString()
    }));
    ways.push(...signWays);

    const signPhotos = images.slice(0, LIMITS.photosMax).map((p, i) => {
      const photoId = ulidFrom(time, `archive-photo:${stem}:${i}`).toLowerCase();
      photos.push({ id: photoId, signId: id, source: seed.photo_swaps[p.image!] ?? p.image! });
      return { id: photoId, width: 0, height: 0, alt: `Photo of the ${meta.title} sign` };
    });
    const slug = uniqueSlug(slugify(meta.title), (s) => slugs.has(s));
    slugs.add(slug);
    const caption = fix?.caption === undefined ? captionOf(post.body) : fix.caption;
    const firstWay = signWays[0];
    signs.push({
      id,
      slug,
      title: meta.title,
      ...(caption ? { caption } : {}),
      photos: signPhotos,
      numbers: numbers.map((value) => ({ value })),
      place,
      foundOn: dates.found_on,
      postedAt,
      postedBy: finder.id,
      finders: [{ playerId: finder.id, name: finder.name, role: 'found' }],
      visibility: 'shown',
      firstWay: { text: firstWay.text, value: firstWay.value, playerId: firstWay.playerId },
      wayCount: signWays.length
    });
  }
  if (problems.length) throw new Error(`The archive plan has problems:\n  ${problems.join('\n  ')}`);
  return { players: [...players.values()], signs, ways, photos, left };
}

/** A row of the old site's user tables. Sources come newest first. */
export type LegacyUser = { keys: string[]; email: string };

/**
 * Which old address claims which new player, so a returning player signs in and finds their
 * signs. One address per player, since deleting a player frees just the one. An address that
 * matches two players goes to neither. The answer holds addresses: never print or save it.
 */
export function linkEmails(
  players: PlannedPlayer[],
  users: LegacyUser[]
): { emails: Map<string, string>; unmatched: string[]; shared: string[]; extra: number } {
  const newcomers = players.filter((p) => !p.existingHandle);
  const matches = new Map<string, string[]>();
  const owners = new Map<string, Set<string>>();
  for (const { player, keys } of newcomers) {
    // A full name beats a username: usernames like "Frank" were shared by more than one Frank.
    const matching = (wanted: string[]): string[] =>
      users
        .filter((user) => user.keys.some((k) => wanted.includes(k.trim().toLowerCase())))
        .map((user) => normalizeEmail(user.email))
        .filter(Boolean);
    const byName = matching(keys.slice(0, 1));
    const found = [...new Set(byName.length ? byName : matching(keys))];
    matches.set(player.name, found);
    for (const email of found) owners.set(email, (owners.get(email) ?? new Set()).add(player.name));
  }
  const emails = new Map<string, string>();
  const unmatched: string[] = [];
  const shared = new Set<string>();
  let extra = 0;
  for (const [name, found] of matches) {
    const own = found.filter((email) => owners.get(email)!.size === 1);
    if (own.length < found.length) shared.add(name);
    if (own.length) emails.set(name, own[0]);
    else unmatched.push(name);
    extra += Math.max(0, own.length - 1);
  }
  return { emails, unmatched, shared: [...shared], extra };
}

export type LoadDeps = {
  store: Store;
  photos: PhotoStore;
  /** The bytes of a planned photo, by its `source`. */
  read: (source: string) => Promise<Buffer>;
};

export type LoadReport = {
  added: number;
  alreadyThere: number;
  playersAdded: number;
  /** Names whose old address already belongs to a player: that player gets their signs. */
  creditedToExisting: string[];
};

/**
 * Writes a plan, leaving alone any sign already there, so running it again writes nothing new.
 * Slugs and handles that today's players hold move aside; a player whose old address is already
 * in the game gets the signs on the account they have.
 */
export async function loadArchive(
  plan: ArchivePlan,
  deps: LoadDeps,
  emails: Map<string, string> = new Map()
): Promise<LoadReport> {
  const { store, photos } = deps;
  // A sign the owner merged into another (`merge-signs`) counts as there: a run never brings it back.
  const merged = mergedAway(await store.allSigns());
  const present = new Set(plan.signs.filter((s) => merged.has(s.id)).map((s) => s.id));
  for (const sign of plan.signs) if (await store.getSign(sign.id)) present.add(sign.id);

  const everyone = await store.allPlayers();
  const actual = new Map<string, Player>();
  const creditedToExisting: string[] = [];
  let playersAdded = 0;
  for (const { player, existingHandle } of plan.players) {
    if (existingHandle) {
      const found = everyone.find((p) => p.handle === existingHandle);
      if (!found) throw new Error(`No player @${existingHandle}: load the launch signs first`);
      actual.set(player.id, found);
      continue;
    }
    const email = emails.get(player.name);
    const ownerId = email && (await store.playerIdForEmail(email));
    if (ownerId && ownerId !== player.id) {
      const owner = await store.getPlayer(ownerId);
      if (owner) {
        actual.set(player.id, owner);
        creditedToExisting.push(player.name);
        continue;
      }
    }
    const saved = await store.getPlayer(player.id);
    if (saved) {
      actual.set(player.id, saved);
      continue;
    }
    const row: Player = { ...player, ...(email ? { email } : {}) };
    let n = 1;
    while (!(await store.claimHandle(row.handle, row.id))) row.handle = `${player.handle}-${++n}`;
    if (email && (await store.claimEmail(email, row.id)) !== row.id) {
      throw new Error(`${player.name}'s address went to another player just now; run it again`);
    }
    await store.putPlayer(row);
    actual.set(player.id, row);
    playersAdded++;
  }
  const idOf = (planned: string): string => actual.get(planned)?.id ?? planned;

  const signs = new Map(plan.signs.map((s) => [s.id, s]));
  for (const photo of plan.photos) {
    if (present.has(photo.signId)) continue;
    const sized = await renditions(await deps.read(photo.source));
    await photos.putUpload(photo.id, sized);
    await photos.publish(photo.id, 'shown');
    const entry = signs.get(photo.signId)!.photos.find((p) => p.id === photo.id)!;
    entry.width = sized.width;
    entry.height = sized.height;
  }
  // Ways before their sign, as a post does, so a sign is never public without its first way.
  for (const way of plan.ways) {
    if (present.has(way.signId)) continue;
    await store.claimWay(way.signId, way.text, way.id);
    await store.putWay({ ...way, playerId: idOf(way.playerId) });
  }
  for (const sign of plan.signs) {
    if (present.has(sign.id)) continue;
    let slug = sign.slug;
    let n = 1;
    while (!(await store.claimSlug(slug, sign.id))) slug = `${sign.slug}-${++n}`;
    await store.releaseSlug(slug, sign.id);
    await addSign(store, {
      ...sign,
      slug,
      postedBy: idOf(sign.postedBy),
      finders: sign.finders.map((f) => ({
        ...f,
        playerId: idOf(f.playerId!),
        name: actual.get(f.playerId!)?.name || f.name
      })),
      firstWay: { ...sign.firstWay!, playerId: idOf(sign.firstWay!.playerId) }
    });
  }
  return { added: plan.signs.length - present.size, alreadyThere: present.size, playersAdded, creditedToExisting };
}
