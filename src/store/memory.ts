import type { Block, Login, Player, Report, Session, Sign, Upload, Way } from '../domain/types.ts';
import {
  addPlayer,
  addSign,
  emailHash,
  nowSeconds,
  type PlayerChanges,
  type SignChanges,
  type Store
} from './store.ts';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  private signs = new Map<string, Sign>();
  private ways = new Map<string, Way[]>();
  private players = new Map<string, Player>();
  private emails = new Map<string, string>();
  private handles = new Map<string, string>();
  private slugs = new Map<string, string>();
  private logins = new Map<string, Login>();
  private sessions = new Map<string, Session>();
  private counters = new Map<string, number>();
  private uploads = new Map<string, Upload>();
  private reports = new Map<string, Report>();
  private blocks = new Map<string, Block>();
  private claims = new Map<string, { signId: string; expiresAt: number }>();
  private wayTexts = new Map<string, string>();

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

  async updateSign(id: string, changes: SignChanges): Promise<boolean> {
    const sign = this.signs.get(id);
    if (!sign) return false;
    for (const [field, value] of Object.entries(copy(changes))) {
      if (value === null) delete (sign as Record<string, unknown>)[field];
      else if (value !== undefined) (sign as Record<string, unknown>)[field] = value;
    }
    return true;
  }

  async claimSlug(slug: string, signId: string): Promise<boolean> {
    if (!this.slugs.has(slug)) this.slugs.set(slug, signId);
    return this.slugs.get(slug) === signId;
  }

  async releaseSlug(slug: string, signId: string): Promise<void> {
    if (this.slugs.get(slug) === signId) this.slugs.delete(slug);
  }

  async deleteSign(id: string): Promise<void> {
    const sign = this.signs.get(id);
    if (sign && this.slugs.get(sign.slug) === id) this.slugs.delete(sign.slug);
    this.signs.delete(id);
    this.ways.delete(id);
    for (const key of this.wayTexts.keys()) if (key.startsWith(`${id}/`)) this.wayTexts.delete(key);
    for (const [key, report] of this.reports) if (report.signId === id) this.reports.delete(key);
  }

  async listWays(signId: string): Promise<Way[]> {
    return (this.ways.get(signId) ?? []).map(copy).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async claimWay(signId: string, text: string, wayId: string): Promise<boolean> {
    const key = `${signId}/${text}`;
    if (!this.wayTexts.has(key)) this.wayTexts.set(key, wayId);
    return this.wayTexts.get(key) === wayId;
  }

  async putWay(way: Way): Promise<void> {
    const list = (this.ways.get(way.signId) ?? []).filter((w) => w.id !== way.id);
    list.push(copy(way));
    this.ways.set(way.signId, list);
  }

  async deleteWay(way: Way): Promise<void> {
    const key = `${way.signId}/${way.text}`;
    if (this.wayTexts.get(key) === way.id) this.wayTexts.delete(key);
    this.ways.set(
      way.signId,
      (this.ways.get(way.signId) ?? []).filter((w) => w.id !== way.id)
    );
  }

  async countWay(signId: string, first: NonNullable<Sign['firstWay']>): Promise<void> {
    const sign = this.signs.get(signId);
    if (!sign) return;
    sign.wayCount = (sign.wayCount ?? 0) + 1;
    sign.firstWay ??= copy(first);
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
    const prefix = `${id}/`;
    for (const map of [this.sessions, this.uploads, this.blocks, this.claims]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
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

  async putUpload(upload: Upload): Promise<void> {
    this.uploads.set(`${upload.playerId}/${upload.photoId}`, copy(upload));
  }

  async getUpload(playerId: string, photoId: string): Promise<Upload | undefined> {
    const upload = this.uploads.get(`${playerId}/${photoId}`);
    return upload && upload.expiresAt > nowSeconds() ? copy(upload) : undefined;
  }

  async claimUpload(playerId: string, photoId: string, signId: string): Promise<boolean> {
    const upload = this.uploads.get(`${playerId}/${photoId}`);
    if (!upload || upload.expiresAt <= nowSeconds() || upload.signId) return false;
    upload.signId = signId;
    return true;
  }

  async releaseUpload(playerId: string, photoId: string, signId: string): Promise<void> {
    const upload = this.uploads.get(`${playerId}/${photoId}`);
    if (upload?.signId === signId) delete upload.signId;
  }

  async deleteUpload(playerId: string, photoId: string): Promise<void> {
    this.uploads.delete(`${playerId}/${photoId}`);
  }

  async putReport(report: Report): Promise<void> {
    this.reports.set(`${report.signId}/${report.playerId}`, copy(report));
  }

  async getReport(signId: string, playerId: string): Promise<Report | undefined> {
    const report = this.reports.get(`${signId}/${playerId}`);
    return report && copy(report);
  }

  async deleteReport(signId: string, playerId: string): Promise<void> {
    this.reports.delete(`${signId}/${playerId}`);
  }

  async putBlock(block: Block): Promise<void> {
    this.blocks.set(`${block.playerId}/${block.blockedId}`, copy(block));
  }

  async deleteBlock(playerId: string, blockedId: string): Promise<void> {
    this.blocks.delete(`${playerId}/${blockedId}`);
  }

  async listBlocks(playerId: string): Promise<Block[]> {
    return [...this.blocks.values()].filter((b) => b.playerId === playerId).map(copy);
  }

  async claimPost(playerId: string, key: string, signId: string, seconds: number): Promise<string | undefined> {
    const k = `${playerId}/${key}`;
    const now = nowSeconds();
    const held = this.claims.get(k);
    if (held && held.expiresAt > now) return held.signId;
    this.claims.set(k, { signId, expiresAt: now + seconds });
    return undefined;
  }

  async releasePost(playerId: string, key: string): Promise<void> {
    this.claims.delete(`${playerId}/${key}`);
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
    for (const s of data.signs) await addSign(store, s);
    for (const w of data.ways) {
      await store.claimWay(w.signId, w.text, w.id);
      await store.putWay(w);
    }
    return store;
  }
}
