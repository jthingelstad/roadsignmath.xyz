// Turns the micro.blog export (feed.json) and seed/microblog.json into players, signs and ways.
// Pure: reading the export and processing photos happen in tools/seed-microblog.ts.

import { check, numbersNotOnSign } from '../domain/equation.ts';
import { slugify, ulidFrom, uniqueSlug } from '../domain/ids.ts';
import type { Player, Sign, SignNumber, Way } from '../domain/types.ts';

export type FeedItem = { url: string; title?: string | null; content_text: string; date_published: string };

export type SeedFile = {
  posted_by: string;
  players: { handle: string; name: string; avatar_color: string; bio?: string }[];
  signs: {
    /** The post's path under the blog, "2023/10/21/genesis.html". */
    post: string;
    title: string;
    finder: string;
    math: string;
    numbers: SignNumber[];
    place: { label: string; state?: string; lat?: number; lng?: number };
    /** One per photo in the post, in order. */
    alt: string[];
  }[];
};

export type Plan = {
  players: Player[];
  signs: Sign[];
  ways: Way[];
  /** Where each photo comes from in the export, by photo id. */
  photos: { id: string; source: string; signId: string }[];
};

/** The post's own words: no math, no images, links reduced to their text. */
export function captionOf(text: string): string | undefined {
  const caption = text
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .replace(/<img\b[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  return caption || undefined;
}

export const imagesOf = (text: string): string[] => [...text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);

export function buildPlan(feed: FeedItem[], seed: SeedFile): Plan {
  const problems: string[] = [];
  const byPost = new Map(feed.map((item) => [new URL(item.url).pathname.replace(/^\//, ''), item]));
  const handles = new Map<string, string>();
  const players: Player[] = seed.players.map((p) => {
    const id = ulidFrom(Date.parse('2021-01-01T00:00:00Z'), `player:${p.handle}`);
    handles.set(p.handle, id);
    return {
      id,
      handle: p.handle,
      name: p.name,
      avatarColor: p.avatar_color,
      ...(p.bio ? { bio: p.bio } : {}),
      createdAt: '2021-01-01T00:00:00.000Z'
    };
  });
  const postedBy = handles.get(seed.posted_by);
  if (!postedBy) problems.push(`posted_by ${seed.posted_by} is not a player`);

  const signs: Sign[] = [];
  const ways: Way[] = [];
  const photos: Plan['photos'] = [];
  const slugs = new Set<string>();
  for (const s of seed.signs) {
    const item = byPost.get(s.post);
    if (!item) {
      problems.push(`${s.post}: not in the export`);
      continue;
    }
    const playerId = handles.get(s.finder);
    if (!playerId) problems.push(`${s.post}: finder ${s.finder} is not a player`);
    const result = check(s.math);
    if (!result.ok) {
      problems.push(`${s.post}: ${result.message}`);
      continue;
    }
    if (result.canonical !== s.math) problems.push(`${s.post}: write the math as ${result.canonical}`);
    const extra = numbersNotOnSign(
      result.numbers,
      s.numbers.map((n) => n.value)
    );
    if (extra.length) problems.push(`${s.post}: ${extra.join(', ')} not among the sign's numbers`);
    const images = imagesOf(item.content_text);
    if (images.length !== s.alt.length) {
      problems.push(`${s.post}: ${images.length} photos but ${s.alt.length} alt texts`);
    }

    const time = Date.parse(item.date_published);
    const postedAt = new Date(time).toISOString();
    const id = ulidFrom(time, `sign:${s.post}`);
    const slug = uniqueSlug(slugify(s.title), (x) => slugs.has(x));
    slugs.add(slug);
    const signPhotos = images.map((source, i) => {
      const photoId = ulidFrom(time, `photo:${s.post}:${i}`).toLowerCase();
      photos.push({ id: photoId, source, signId: id });
      return { id: photoId, width: 0, height: 0, alt: s.alt[i] ?? `Photo of the ${s.title} sign` };
    });
    const hasPin = s.place.lat !== undefined && s.place.lng !== undefined;
    signs.push({
      id,
      slug,
      title: s.title,
      ...(captionOf(item.content_text) ? { caption: captionOf(item.content_text) } : {}),
      photos: signPhotos,
      numbers: s.numbers,
      place: { ...s.place, approximate: true },
      // The date as the post gave it, in its own time zone.
      foundOn: item.date_published.slice(0, 10),
      postedAt,
      postedBy: postedBy ?? '',
      finders: [{ playerId, name: seed.players.find((p) => p.handle === s.finder)?.name ?? s.finder, role: 'found' }],
      visibility: 'shown',
      firstWay: { text: result.canonical, value: result.value },
      wayCount: 1
    });
    if (!hasPin && (s.place.lat !== undefined || s.place.lng !== undefined)) {
      problems.push(`${s.post}: a pin needs both lat and lng`);
    }
    ways.push({
      id: ulidFrom(time, `way:${s.post}`),
      signId: id,
      playerId: playerId ?? '',
      text: result.canonical,
      value: result.value,
      numbers: result.numbers,
      createdAt: postedAt
    });
  }
  const seeded = new Set(seed.signs.map((s) => s.post));
  for (const post of byPost.keys()) if (!seeded.has(post)) problems.push(`${post}: in the export but not seeded`);
  if (problems.length) throw new Error(`The seed doesn't fit the export:\n- ${problems.join('\n- ')}`);
  return { players, signs, ways, photos };
}
