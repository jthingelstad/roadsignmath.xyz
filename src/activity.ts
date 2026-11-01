// What's new on your signs (`GET /me/activity`): the ways other players found and the hearts
// they gave on the signs you posted or are a finder of, in any state, newest first. Website
// kudos have no player, so they aren't here. Showing who hearted is Jamie's design (2026-10-31).

import { LIMITS } from './api/contract.ts';
import { heldPhotoUrl, isPublic, photoUrl, type Urls } from './api/views.ts';
import { texOf } from './domain/equation.ts';
import type { Player, Sign } from './domain/types.ts';
import type { Store } from './store/store.ts';

const DAY = 86400;

type Item = {
  kind: 'way' | 'heart';
  at: string;
  sign: { id: string; slug: string; title: string; photo_thumb_url: string | null };
  player: { handle: string | null; name: string | null; avatar_color: string; avatar_thumb_url: string | null };
  way: { id: string; text: string; tex: string | null } | null;
  /** Orders items made at the same moment; not sent. */
  key: string;
};

export async function myActivity(store: Store, urls: Urls, me: Player, now: number) {
  const since = new Date((now - LIMITS.activityDays * DAY) * 1000).toISOString();
  const [signs, players, blocks] = await Promise.all([store.allSigns(), store.allPlayers(), store.listBlocks(me.id)]);
  const blocked = new Set(blocks.map((b) => b.blockedId));
  const people = new Map(players.map((p) => [p.id, p]));
  const mine = new Map(
    signs.filter((s) => s.postedBy === me.id || s.finders.some((f) => f.playerId === me.id)).map((s) => [s.id, s])
  );
  const others = (playerId: string) => playerId !== me.id && !blocked.has(playerId) && people.has(playerId);

  const signRef = (sign: Sign) => {
    const photo = sign.photos[0];
    const url = !photo
      ? null
      : isPublic(sign)
        ? photoUrl(urls, photo.id, 'thumb')
        : sign.postedBy === me.id
          ? heldPhotoUrl(urls, photo.id, 'thumb')
          : null;
    return { id: sign.id, slug: sign.slug, title: sign.title, photo_thumb_url: url };
  };
  const who = (player: Player) => ({
    handle: player.name ? player.handle : null,
    name: player.name || null,
    avatar_color: player.avatarColor,
    avatar_thumb_url: player.avatar ? photoUrl(urls, player.avatar, 'thumb') : null
  });

  // Every way on each of your signs, and every other player's hearts, one query each. Players
  // are read whole: fine at this size (a few dozen players and signs); a by-sign heart row
  // would be the next step if it grows.
  const [ways, hearts] = await Promise.all([
    Promise.all([...mine.keys()].map((id) => store.listWays(id))),
    Promise.all(players.filter((p) => others(p.id)).map((p) => store.listHearts(p.id)))
  ]);

  const items: Item[] = [];
  for (const way of ways.flat()) {
    if (way.createdAt < since || !others(way.playerId)) continue;
    items.push({
      kind: 'way',
      at: way.createdAt,
      sign: signRef(mine.get(way.signId)!),
      player: who(people.get(way.playerId)!),
      way: { id: way.id, text: way.text, tex: texOf(way.text) ?? null },
      key: `way:${way.id}`
    });
  }
  for (const heart of hearts.flat()) {
    const sign = mine.get(heart.signId);
    if (!sign || heart.createdAt < since) continue;
    items.push({
      kind: 'heart',
      at: heart.createdAt,
      sign: signRef(sign),
      player: who(people.get(heart.playerId)!),
      way: null,
      key: `heart:${heart.signId}:${heart.playerId}`
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
  return {
    days: LIMITS.activityDays,
    items: items.slice(0, LIMITS.activityMax).map(({ key: _key, ...item }) => item)
  };
}
