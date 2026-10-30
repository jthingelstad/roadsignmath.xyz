import { createHash } from 'node:crypto';
import type { Login, Player, Session, Sign, Way } from '../domain/types.ts';

/**
 * Where signs, ways and players live. Two versions: MemoryStore (tests and `npm run dev`) and
 * DynamoStore (the live table). At this size every list is read whole and filtered in memory.
 */
export interface Store {
  /** Every sign, whatever its visibility. */
  allSigns(): Promise<Sign[]>;
  getSign(id: string): Promise<Sign | undefined>;
  putSign(sign: Sign): Promise<void>;
  /** Removes the sign and its ways. */
  deleteSign(id: string): Promise<void>;
  /** Oldest first. */
  listWays(signId: string): Promise<Way[]>;
  putWay(way: Way): Promise<void>;
  deleteWay(way: Way): Promise<void>;
  allPlayers(): Promise<Player[]>;
  getPlayer(id: string): Promise<Player | undefined>;
  /** Also indexes the player's email, when it has one. */
  putPlayer(player: Player): Promise<void>;
  playerIdForEmail(email: string): Promise<string | undefined>;
  /** Removes the player, their email index entry and their sessions. Signs and ways are the caller's. */
  deletePlayer(id: string): Promise<void>;

  putLogin(login: Login): Promise<void>;
  /** Missing once it has expired, even before the table's time-to-live removes it. */
  getLogin(id: string): Promise<Login | undefined>;
  deleteLogin(id: string): Promise<void>;

  putSession(session: Session): Promise<void>;
  /** Missing once it has expired. */
  getSession(playerId: string, secretHash: string): Promise<Session | undefined>;
  deleteSession(playerId: string, secretHash: string): Promise<void>;

  /**
   * Counts one more use of `key` in the window that holds `now` (epoch seconds) and returns the
   * count so far. Windows start on multiples of `seconds`.
   */
  bump(key: string, seconds: number, now: number): Promise<number>;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const emailHash = (email: string): string => createHash('sha256').update(normalizeEmail(email)).digest('hex');
