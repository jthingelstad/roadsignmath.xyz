// What Quiz reads: the shown signs a player sees, the ways and co-finds on each, which of them a
// player has solved, and the next sign to try. Read whole, like the API: there are few signs.

import { earnedBadges, type Earned } from '../domain/badges.ts';
import type { CoFind, Player, Sign, Way } from '../domain/types.ts';
import { byNewest, isPublic, type People } from '../api/views.ts';
import type { Store } from '../store/store.ts';

export type OnSign = { ways: Way[]; coFinds: CoFind[] };

export type QuizData = {
  /** The shown signs the player sees (none posted by a player they blocked), newest first. */
  signs: Sign[];
  people: People;
  blocked: Set<string>;
};

export async function loadQuiz(store: Store, player: Player | undefined): Promise<QuizData> {
  const [signs, players, blocks] = await Promise.all([
    store.allSigns(),
    store.allPlayers(),
    player ? store.listBlocks(player.id) : []
  ]);
  const blocked = new Set(blocks.map((b) => b.blockedId));
  return {
    signs: signs.filter((s) => isPublic(s) && !blocked.has(s.postedBy)).sort(byNewest),
    people: new Map(players.map((p) => [p.id, p])),
    blocked
  };
}

/** The ways and co-finds on each of these signs, one read of each per sign. */
export async function onSigns(store: Store, signs: Sign[]): Promise<Map<string, OnSign>> {
  const read = await Promise.all(
    signs.map(async (s) => {
      const [ways, coFinds] = await Promise.all([store.listWays(s.id), store.listCoFinds(s.id)]);
      return [s.id, { ways, coFinds }] as const;
    })
  );
  return new Map(read);
}

/** Whether the sign credits the player: they posted it or are one of its finders. */
export const credits = (sign: Sign, playerId: string): boolean =>
  sign.postedBy === playerId || sign.finders.some((f) => f.playerId === playerId);

/**
 * How the player solved a sign, if they did: the first way on a sign that doesn't credit them
 * (`first`, Tag Team's way), a way of theirs (`new`), or a way they found too (`too`). The way
 * they found most recently counts.
 */
export type Solve = { kind: 'first' | 'new' | 'too'; way: Way; at: string };

export function solveOf(sign: Sign, on: OnSign, playerId: string): Solve | undefined {
  const found: Solve[] = [];
  on.ways.forEach((way, i) => {
    if (way.playerId !== playerId) return;
    found.push({ kind: i === 0 && !credits(sign, playerId) ? 'first' : 'new', way, at: way.createdAt });
  });
  for (const c of on.coFinds) {
    if (c.playerId !== playerId) continue;
    const way = on.ways.find((w) => w.id === c.wayId);
    if (way) found.push({ kind: 'too', way, at: c.createdAt });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at))[0];
}

/** The signs the player solved, the most recent first. */
export function solvedBy(data: QuizData, on: Map<string, OnSign>, playerId: string): { sign: Sign; solve: Solve }[] {
  return data.signs
    .flatMap((sign) => {
      const solve = solveOf(sign, on.get(sign.id) ?? { ways: [], coFinds: [] }, playerId);
      return solve ? [{ sign, solve }] : [];
    })
    .sort((a, b) => b.solve.at.localeCompare(a.solve.at));
}

/**
 * The signs still to try: shown, with numbers, not posted or found by the player, and not solved
 * by them. Skipping a sign records nothing, so a skipped sign stays here.
 */
export function stillToTry(data: QuizData, on: Map<string, OnSign>, playerId: string): Sign[] {
  return data.signs.filter(
    (s) =>
      s.numbers.length > 0 && !credits(s, playerId) && !solveOf(s, on.get(s.id) ?? { ways: [], coFinds: [] }, playerId)
  );
}

/** A sign picked at random from those still to try, other than `after` when there is another. */
export function draw(left: Sign[], after?: string, random: () => number = Math.random): Sign | undefined {
  const pool = left.length > 1 ? left.filter((s) => s.slug !== after) : left;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * The player's badges whose earning sign is this one: what the way they just found here earned.
 * Read as they see the signs (blocked players' ways left out), like the API's badges.
 */
export function badgesFrom(data: QuizData, on: Map<string, OnSign>, playerId: string, sign: Sign): Earned[] {
  const ways = new Map([...on].map(([id, o]) => [id, o.ways]));
  return earnedBadges(playerId, data.signs, ways, data.blocked).filter((e) => e.sign.id === sign.id);
}
