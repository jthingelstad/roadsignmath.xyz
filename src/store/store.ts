import { createHash } from 'node:crypto';
import type { Player, Sign, Way } from '../domain/types.ts';

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
  allPlayers(): Promise<Player[]>;
  getPlayer(id: string): Promise<Player | undefined>;
  /** Also indexes the player's email, when it has one. */
  putPlayer(player: Player): Promise<void>;
  playerIdForEmail(email: string): Promise<string | undefined>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const emailHash = (email: string): string => createHash('sha256').update(normalizeEmail(email)).digest('hex');
