import type { Player, Sign, Way } from '../domain/types.ts';
import { emailHash, type Store } from './store.ts';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  private signs = new Map<string, Sign>();
  private ways = new Map<string, Way[]>();
  private players = new Map<string, Player>();
  private emails = new Map<string, string>();

  async allSigns(): Promise<Sign[]> {
    return [...this.signs.values()].map(copy);
  }

  async getSign(id: string): Promise<Sign | undefined> {
    const sign = this.signs.get(id);
    return sign && copy(sign);
  }

  async putSign(sign: Sign): Promise<void> {
    this.signs.set(sign.id, copy(sign));
  }

  async deleteSign(id: string): Promise<void> {
    this.signs.delete(id);
    this.ways.delete(id);
  }

  async listWays(signId: string): Promise<Way[]> {
    return (this.ways.get(signId) ?? []).map(copy).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async putWay(way: Way): Promise<void> {
    const list = (this.ways.get(way.signId) ?? []).filter((w) => w.id !== way.id);
    list.push(copy(way));
    this.ways.set(way.signId, list);
  }

  async allPlayers(): Promise<Player[]> {
    return [...this.players.values()].map(copy);
  }

  async getPlayer(id: string): Promise<Player | undefined> {
    const player = this.players.get(id);
    return player && copy(player);
  }

  async putPlayer(player: Player): Promise<void> {
    this.players.set(player.id, copy(player));
    if (player.email) this.emails.set(emailHash(player.email), player.id);
  }

  async playerIdForEmail(email: string): Promise<string | undefined> {
    return this.emails.get(emailHash(email));
  }

  /** For `npm run dev`: everything, to save between runs. */
  snapshot(): { signs: Sign[]; ways: Way[]; players: Player[] } {
    return {
      signs: [...this.signs.values()],
      ways: [...this.ways.values()].flat(),
      players: [...this.players.values()]
    };
  }

  static async from(data: { signs: Sign[]; ways: Way[]; players: Player[] }): Promise<MemoryStore> {
    const store = new MemoryStore();
    for (const p of data.players) await store.putPlayer(p);
    for (const s of data.signs) await store.putSign(s);
    for (const w of data.ways) await store.putWay(w);
    return store;
  }
}
