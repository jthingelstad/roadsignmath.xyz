import type { Login, Player, Session, Sign, Way } from '../domain/types.ts';
import { addPlayer, emailHash, nowSeconds, type PlayerChanges, type Store } from './store.ts';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  private signs = new Map<string, Sign>();
  private ways = new Map<string, Way[]>();
  private players = new Map<string, Player>();
  private emails = new Map<string, string>();
  private handles = new Map<string, string>();
  private logins = new Map<string, Login>();
  private sessions = new Map<string, Session>();
  private counters = new Map<string, number>();

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

  async deleteWay(way: Way): Promise<void> {
    this.ways.set(
      way.signId,
      (this.ways.get(way.signId) ?? []).filter((w) => w.id !== way.id)
    );
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
  }

  async updatePlayer(id: string, changes: PlayerChanges, onlyIfUnnamed = false): Promise<boolean> {
    const player = this.players.get(id);
    if (!player || (onlyIfUnnamed && player.name)) return false;
    if (changes.name !== undefined) player.name = changes.name;
    if (changes.handle !== undefined) player.handle = changes.handle;
    if (changes.bio === null) delete player.bio;
    else if (changes.bio !== undefined) player.bio = changes.bio;
    return true;
  }

  async claimEmail(email: string, playerId: string): Promise<string> {
    const key = emailHash(email);
    if (!this.emails.has(key)) this.emails.set(key, playerId);
    return this.emails.get(key)!;
  }

  async claimHandle(handle: string, playerId: string): Promise<boolean> {
    if (!this.handles.has(handle)) this.handles.set(handle, playerId);
    return this.handles.get(handle) === playerId;
  }

  async releaseHandle(handle: string, playerId: string): Promise<void> {
    if (this.handles.get(handle) === playerId) this.handles.delete(handle);
  }

  async playerIdForEmail(email: string): Promise<string | undefined> {
    return this.emails.get(emailHash(email));
  }

  async deletePlayer(id: string): Promise<void> {
    const player = this.players.get(id);
    if (player?.email && this.emails.get(emailHash(player.email)) === id) this.emails.delete(emailHash(player.email));
    if (player) await this.releaseHandle(player.handle, id);
    this.players.delete(id);
    for (const [key, session] of this.sessions) if (session.playerId === id) this.sessions.delete(key);
  }

  async putLogin(login: Login): Promise<void> {
    this.logins.set(login.id, copy(login));
  }

  async getLogin(id: string): Promise<Login | undefined> {
    const login = this.logins.get(id);
    return login && login.expiresAt > nowSeconds() ? copy(login) : undefined;
  }

  async deleteLogin(id: string): Promise<void> {
    this.logins.delete(id);
  }

  async addLoginAttempt(id: string): Promise<number | undefined> {
    const login = this.logins.get(id);
    if (!login || login.expiresAt <= nowSeconds()) return undefined;
    login.attempts += 1;
    return login.attempts;
  }

  async consumeLogin(id: string): Promise<boolean> {
    const login = this.logins.get(id);
    if (!login || login.expiresAt <= nowSeconds()) return false;
    this.logins.delete(id);
    return true;
  }

  async putSession(session: Session): Promise<void> {
    this.sessions.set(`${session.playerId}/${session.secretHash}`, copy(session));
  }

  async getSession(playerId: string, secretHash: string): Promise<Session | undefined> {
    const session = this.sessions.get(`${playerId}/${secretHash}`);
    return session && session.expiresAt > nowSeconds() ? copy(session) : undefined;
  }

  async deleteSession(playerId: string, secretHash: string): Promise<void> {
    this.sessions.delete(`${playerId}/${secretHash}`);
  }

  async bump(key: string, seconds: number, now: number): Promise<number> {
    const k = `${key}@${now - (now % seconds)}`;
    const count = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, count);
    return count;
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
    for (const p of data.players) await addPlayer(store, p);
    for (const s of data.signs) await store.putSign(s);
    for (const w of data.ways) await store.putWay(w);
    return store;
  }
}
