// What the API sends: snake_case JSON built from the stored records. A player's email never
// leaves the server, and only shown signs are public.

import type { Player, Sign, Way } from '../domain/types.ts';

export type Urls = {
  /** The site's origin, "https://roadsignmath.xyz". */
  site: string;
};

export const signUrl = (urls: Urls, sign: Sign): string => `${urls.site}/signs/${sign.slug}`;
export const playerUrl = (urls: Urls, player: Player): string => `${urls.site}/players/${player.handle}`;
export const photoUrl = (urls: Urls, photoId: string, size: 'large' | 'thumb'): string =>
  `${urls.site}/p/${photoId}/${size}.jpg`;
/** A held or hidden sign's photo, which only its poster can fetch, with their token. */
export const heldPhotoUrl = (urls: Urls, photoId: string, size: 'large' | 'thumb'): string =>
  `${urls.site}/api/v1/me/photos/${photoId}/${size}`;

export const isPublic = (sign: Sign): boolean => sign.visibility === 'shown';

/** What one reader sees: shown signs and their own, less the posts of players they blocked. */
export const visibleTo =
  (viewerId: string | undefined, blocked: Set<string>) =>
  (sign: Sign): boolean =>
    (isPublic(sign) || sign.postedBy === viewerId) && !blocked.has(sign.postedBy);

/** Newest first; postedAt ties go to the larger id. */
export const byNewest = (a: Sign, b: Sign): number => b.postedAt.localeCompare(a.postedAt) || b.id.localeCompare(a.id);

export type People = Map<string, Player>;

function handleOf(people: People, playerId: string | undefined): string | null {
  return (playerId && people.get(playerId)?.handle) || null;
}

/** A sign as the feed, the map sheet and a player's grid show it, to a reader who blocked `blocked`. */
export function signSummary(urls: Urls, people: People, sign: Sign, blocked: ReadonlySet<string> = new Set()) {
  const url = isPublic(sign) ? photoUrl : heldPhotoUrl;
  const first = sign.firstWay && !blocked.has(sign.firstWay.playerId) ? sign.firstWay : undefined;
  return {
    id: sign.id,
    slug: sign.slug,
    title: sign.title,
    url: signUrl(urls, sign),
    caption: sign.caption ?? null,
    found_on: sign.foundOn,
    posted_at: sign.postedAt,
    posted_by: handleOf(people, sign.postedBy),
    place: {
      label: sign.place.label,
      state: sign.place.state ?? null,
      lat: sign.place.lat ?? null,
      lng: sign.place.lng ?? null,
      approximate: sign.place.approximate
    },
    photos: sign.photos.map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      alt: p.alt,
      url: url(urls, p.id, 'large'),
      thumb_url: url(urls, p.id, 'thumb')
    })),
    numbers: sign.numbers.map((n) => ({
      value: n.value,
      text: n.text ?? null,
      why: n.why ?? null,
      box: n.box ?? null
    })),
    finders: sign.finders.map((f) => ({ name: f.name, handle: handleOf(people, f.playerId), role: f.role })),
    first_way: first ? { text: first.text, value: first.value } : null,
    way_count: sign.wayCount,
    visibility: sign.visibility,
    moderation_note: sign.visibility === 'shown' ? null : (sign.moderation?.note ?? null)
  };
}

export function wayView(people: People, way: Way) {
  const player = people.get(way.playerId);
  return {
    id: way.id,
    text: way.text,
    value: way.value,
    numbers: way.numbers,
    by: player ? { handle: player.handle, name: player.name } : null,
    created_at: way.createdAt
  };
}

/** One sign's page: the summary and the ways this reader sees, oldest first. */
export function signDetail(urls: Urls, people: People, sign: Sign, ways: Way[]) {
  const first = ways[0];
  return {
    ...signSummary(urls, people, sign),
    first_way: first ? { text: first.text, value: first.value } : null,
    way_count: ways.length,
    ways: ways.map((w) => wayView(people, w))
  };
}

/** A pin on the map: just enough to draw it and fill the sheet. */
export function pinView(urls: Urls, sign: Sign) {
  const photo = sign.photos[0];
  return {
    id: sign.id,
    slug: sign.slug,
    title: sign.title,
    url: signUrl(urls, sign),
    lat: sign.place.lat ?? null,
    lng: sign.place.lng ?? null,
    approximate: sign.place.approximate,
    state: sign.place.state ?? null,
    found_on: sign.foundOn,
    thumb_url: photo ? (isPublic(sign) ? photoUrl : heldPhotoUrl)(urls, photo.id, 'thumb') : null
  };
}

/** What a player's signs add up to. Signs count when the player found them. */
export function playerStats(player: Player, signs: Sign[]) {
  const theirs = signs.filter((s) => s.finders.some((f) => f.playerId === player.id));
  const states = [...new Set(theirs.map((s) => s.place.state).filter((s): s is string => !!s))].sort();
  const years = theirs.map((s) => Number(s.foundOn.slice(0, 4)));
  return {
    signs: theirs.sort(byNewest),
    sign_count: theirs.length,
    states,
    first_year: years.length ? Math.min(...years) : null
  };
}

export function playerView(urls: Urls, player: Player, signs: Sign[]) {
  const stats = playerStats(player, signs);
  return {
    handle: player.handle,
    name: player.name,
    avatar_color: player.avatarColor,
    bio: player.bio ?? null,
    url: playerUrl(urls, player),
    sign_count: stats.sign_count,
    states: stats.states,
    first_year: stats.first_year
  };
}

/** You, as only you see yourself. */
export function meView(urls: Urls, player: Player, signs: Sign[]) {
  return { ...playerView(urls, player, signs), email: player.email ?? '', needs_name: !player.name };
}
