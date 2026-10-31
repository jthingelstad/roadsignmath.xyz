// The open data files, for anyone building something with the signs: /signs.json (every shown
// sign with its numbers, ways, place, finders and photos), /players.json (every player with a
// page) and /signs.geojson (the signs with a pin, for maps). Only what the public pages and the
// public API already show: shown signs, never an email, never a held or hidden sign.
//
// Each file carries `version`. Adding a field keeps it; renaming or removing one, or changing
// what one means, bumps it. /data documents every field (src/web/docs.tsx).

import { earnedBadges } from '../domain/badges.ts';
import { texOf } from '../domain/equation.ts';
import type { Player, Sign, Way } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import { byNewest, earnedBadgeView, isPublic, photoUrl, playerStats, signUrl, type Urls } from '../api/views.ts';

/** The format of /signs.json, /players.json and /signs.geojson. */
export const DATA_VERSION = 1;

/** Everything the open files and the feeds are made from, read once per request. */
export type OpenData = {
  urls: Urls;
  /** Shown signs, newest posted first. */
  signs: Sign[];
  /** Each shown sign's ways, oldest first. */
  ways: Map<string, Way[]>;
  people: Map<string, Player>;
  /** Players whose page answers: a name, and a sign or a badge on the map. Most signs first. */
  players: Player[];
};

export async function loadOpenData(store: Store, urls: Urls): Promise<OpenData> {
  const [all, everyone] = await Promise.all([store.allSigns(), store.allPlayers()]);
  const signs = all.filter(isPublic).sort(byNewest);
  const lists = await Promise.all(signs.map((s) => store.listWays(s.id)));
  const ways = new Map(signs.map((s, i) => [s.id, lists[i]]));
  const people = new Map(everyone.map((p) => [p.id, p]));
  // The same test as the player's page and the sitemap.
  const players = everyone
    .filter((p) => p.name && (playerStats(p, signs).sign_count || earnedBadges(p.id, signs, ways).length))
    .map((p) => ({ p, count: playerStats(p, signs).sign_count }))
    .sort((a, b) => b.count - a.count || a.p.name.localeCompare(b.p.name))
    .map(({ p }) => p);
  return { urls, signs, ways, people, players };
}

/** When a sign last changed: when it was posted, or its newest way. */
export const signUpdated = (data: OpenData, sign: Sign): string =>
  [sign.postedAt, ...(data.ways.get(sign.id) ?? []).map((w) => w.createdAt)].sort().at(-1)!;

/** The newest change to any of these signs, or null when there are none. */
export const newestUpdate = (data: OpenData, signs: Sign[]): string | null =>
  signs
    .map((s) => signUpdated(data, s))
    .sort()
    .at(-1) ?? null;

export const playerPageUrl = (urls: Urls, player: Player): string => `${urls.site}/players/${player.handle}`;

/** A player as the open files name them: handle, name, and their page when it answers. */
function personOf(data: OpenData, playerId: string | undefined) {
  const player = playerId ? data.people.get(playerId) : undefined;
  if (!player) return null;
  const hasPage = data.players.includes(player);
  return { handle: player.handle, name: player.name, url: hasPage ? playerPageUrl(data.urls, player) : null };
}

/** One sign in /signs.json. */
export function signRecord(data: OpenData, sign: Sign) {
  const { urls } = data;
  const ways = data.ways.get(sign.id) ?? [];
  return {
    id: sign.id,
    slug: sign.slug,
    url: signUrl(urls, sign),
    title: sign.title,
    caption: sign.caption ?? null,
    found_on: sign.foundOn,
    posted_at: sign.postedAt,
    updated_at: signUpdated(data, sign),
    posted_by: personOf(data, sign.postedBy)?.handle ?? null,
    place: {
      label: sign.place.label,
      state: sign.place.state ?? null,
      lat: sign.place.lat ?? null,
      lng: sign.place.lng ?? null,
      approximate: sign.place.approximate
    },
    numbers: sign.numbers.map((n) => ({
      value: n.value,
      text: n.text ?? null,
      why: n.why ?? null,
      box: n.box ?? null
    })),
    finders: sign.finders.map((f) => {
      const person = personOf(data, f.playerId);
      return { name: f.name, handle: person?.handle ?? null, url: person?.url ?? null, role: f.role };
    }),
    way_count: ways.length,
    ways: ways.map((w) => ({
      text: w.text,
      tex: texOf(w.text) ?? null,
      value: w.value,
      numbers: w.numbers,
      by: personOf(data, w.playerId),
      created_at: w.createdAt
    })),
    photos: sign.photos.map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      alt: p.alt,
      url: photoUrl(urls, p.id, 'large'),
      thumb_url: photoUrl(urls, p.id, 'thumb')
    }))
  };
}

/**
 * What may be done with everything the site shares: the signs, the math, the places, the names and
 * the photos. Jamie's call, 2026-10-31: CC BY 4.0 for everything.
 */
export const LICENSE = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  credit: 'Credit the sign’s finders and Road Sign Math, and link to the sign’s page.'
} as const;

/** The header every open file starts with. */
function header(data: OpenData, path: string, title: string, description: string) {
  const states = new Set(data.signs.map((s) => s.place.state).filter(Boolean));
  return {
    version: DATA_VERSION,
    title,
    description,
    home_page_url: `${data.urls.site}/`,
    url: `${data.urls.site}${path}`,
    docs_url: `${data.urls.site}/data`,
    license: LICENSE,
    updated: newestUpdate(data, data.signs),
    counts: {
      signs: data.signs.length,
      players: data.players.length,
      states: states.size,
      ways: [...data.ways.values()].reduce((n, list) => n + list.length, 0)
    }
  };
}

export function signsFile(data: OpenData) {
  return {
    ...header(
      data,
      '/signs.json',
      'Road Sign Math: every sign',
      'Every road sign players have found and made true, newest posted first.'
    ),
    signs: data.signs.map((s) => signRecord(data, s))
  };
}

/** One player in /players.json: what their page shows, never their email. */
export function playerRecord(data: OpenData, player: Player) {
  const { urls, signs, ways } = data;
  const stats = playerStats(player, signs);
  const wrote = [...ways.values()].flat().filter((w) => w.playerId === player.id).length;
  return {
    handle: player.handle,
    name: player.name,
    url: playerPageUrl(urls, player),
    feed_url: `${playerPageUrl(urls, player)}/feed.json`,
    bio: player.bio ?? null,
    avatar_color: player.avatarColor,
    avatar_url: player.avatar ? photoUrl(urls, player.avatar, 'large') : null,
    avatar_thumb_url: player.avatar ? photoUrl(urls, player.avatar, 'thumb') : null,
    sign_count: stats.sign_count,
    way_count: wrote,
    states: stats.states,
    first_year: stats.first_year,
    signs: stats.signs.map((s) => s.slug),
    badges: earnedBadges(player.id, signs, ways).map((e) => {
      const b = earnedBadgeView(urls, e);
      return {
        id: b.id,
        shelf: b.shelf,
        name: b.name,
        how: b.how,
        mark: b.mark,
        earned_on: b.earned_on,
        sign: b.sign.slug
      };
    })
  };
}

export function playersFile(data: OpenData) {
  return {
    ...header(
      data,
      '/players.json',
      'Road Sign Math: the players',
      'Everyone with a sign or a badge on the map, most signs first.'
    ),
    players: data.players.map((p) => playerRecord(data, p))
  };
}

/**
 * /signs.geojson (RFC 7946): a Point for every sign with a place on the map, newest posted
 * first. Properties are flat, so any map tool can show them. A sign with no place is left out;
 * it is in /signs.json with null lat and lng.
 */
export function signsGeoJson(data: OpenData) {
  const { urls } = data;
  const pinned = data.signs.filter((s) => s.place.lat !== undefined && s.place.lng !== undefined);
  return {
    type: 'FeatureCollection',
    // The same header as the other files, as foreign members (RFC 7946 section 6.1).
    ...header(
      data,
      '/signs.geojson',
      'Road Sign Math: every sign on the map',
      'A point for every sign with a place on the map, newest posted first.'
    ),
    features: pinned.map((s) => {
      const first = (data.ways.get(s.id) ?? [])[0];
      const photo = s.photos[0];
      return {
        type: 'Feature',
        id: s.id,
        geometry: { type: 'Point', coordinates: [s.place.lng!, s.place.lat!] },
        properties: {
          slug: s.slug,
          title: s.title,
          url: signUrl(urls, s),
          found_on: s.foundOn,
          place: s.place.label,
          state: s.place.state ?? null,
          approximate: s.place.approximate,
          math: first?.text ?? null,
          way_count: (data.ways.get(s.id) ?? []).length,
          finders: s.finders.map((f) => f.name).join(', '),
          photo_url: photo ? photoUrl(urls, photo.id, 'large') : null,
          thumb_url: photo ? photoUrl(urls, photo.id, 'thumb') : null
        }
      };
    })
  };
}
