// Quiz's share card: the site's Home card (src/web/share.ts), the map with every sign's pin, worked
// out from the same signs and players as Home's page, so it names the very card Home names and the
// card maker has drawn. A sign's own card would show its first way, which is the answer, so Quiz
// never uses it.

import { isPublic, byNewest, playerStats } from '../api/views.ts';
import type { Store } from '../store/store.ts';
import { cluster } from '../web/map.ts';
import { homeCard, type Card } from '../web/share.ts';

export async function quizCard(store: Store): Promise<Card> {
  const [signs, players] = await Promise.all([store.allSigns(), store.allPlayers()]);
  const shown = signs.filter(isPublic).sort(byNewest);
  const playerCount = players.filter((p) => p.name && playerStats(p, shown).sign_count > 0).length;
  const stateCount = new Set(shown.map((s) => s.place.state).filter(Boolean)).size;
  const pins = cluster(shown).clusters.map((k): [number, number, number] => [k.x, k.y, k.signs.length]);
  return homeCard({ signCount: shown.length, playerCount, stateCount, pins });
}
