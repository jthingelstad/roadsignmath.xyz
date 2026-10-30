import { createHash } from 'node:crypto';
import type { Login, Player, Session, Sign, Way } from '../domain/types.ts';

export type PlayerChanges = { name?: string; handle?: string; bio?: string | null };

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
  /** Writes the player's row. The email and handle are claimed separately, first. */
  putPlayer(player: Player): Promise<void>;
  /**
   * Changes some of a player's fields in place; `bio: null` removes the bio. With
   * `onlyIfUnnamed`, changes nothing unless the player still has no name. False when nothing
   * changed because the player is gone or already named.
   */
  updatePlayer(id: string, changes: PlayerChanges, onlyIfUnnamed?: boolean): Promise<boolean>;
  playerIdForEmail(email: string): Promise<string | undefined>;
  /** Points the email at the player unless another player already has it; returns its owner. */
  claimEmail(email: string, playerId: string): Promise<string>;
  /** Reserves the handle for the player; false when another player has it. */
  claimHandle(handle: string, playerId: string): Promise<boolean>;
  /** Frees the handle if this player holds it. */
  releaseHandle(handle: string, playerId: string): Promise<void>;
  /**
   * Removes the player, their email and handle (when they still point at this player) and their
   * sessions. Signs and ways are the caller's.
   */
  deletePlayer(id: string): Promise<void>;

  putLogin(login: Login): Promise<void>;
  /** Missing once it has expired, even before the table's time-to-live removes it. */
  getLogin(id: string): Promise<Login | undefined>;
  deleteLogin(id: string): Promise<void>;
  /** Counts a wrong code and returns the count, or undefined when the login is gone or expired. */
  addLoginAttempt(id: string): Promise<number | undefined>;
  /** Deletes the login if it is still there and live; true when this call did, so it's used once. */
  consumeLogin(id: string): Promise<boolean>;

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

/** For seeding and tests: claims the player's handle and email, then writes the row. */
export async function addPlayer(store: Store, player: Player): Promise<void> {
  if (!(await store.claimHandle(player.handle, player.id))) throw new Error(`handle ${player.handle} is taken`);
  if (player.email && (await store.claimEmail(player.email, player.id)) !== player.id) {
    throw new Error(`player ${player.id}'s email belongs to another player`);
  }
  await store.putPlayer(player);
}
