// Hearts: a player's ❤️ on a sign. The count is Tinylytics' kudos at the sign's path,
// `/signs/<slug>`, so it holds the website's hearts (the kudos button, anyone, no account) and
// the app's (signed-in players, through this server) together. A player's own heart is also a
// row in our table, which says they hearted it and names their kudo's uid for taking it back.
//
// Keeping the two in step: a heart is written under a lease on (player, sign), our row first,
// then the kudo. If Tinylytics fails or doesn't answer, the kudo is taken back (in case it was
// made after all) and the row removed, and the player gets a 503 with nothing changed. If even
// taking it back fails, the row stays: the heart may exist, and DELETE can still remove it. Taking a
// heart back removes the kudo first and the row only once it is gone. The uid is the same for a
// player and a sign every time, so a retry names the same kudo. The uid is a hash: it reveals
// neither the player nor their email.

import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from './api/contract.ts';
import { fail } from './api/errors.ts';
import { limit } from './api/input.ts';
import { isPublic, signPath, type HeartView } from './api/views.ts';
import type { Player, Sign } from './domain/types.ts';
import { nowSeconds, type Store } from './store/store.ts';
import { TinylyticsUnavailable, type Kudo, type Tinylytics } from './tinylytics.ts';

const DAY = 86400;
/** Counts are read again after this long, the same minute the public pages are cached for. */
const COUNTS_FRESH = 60_000;
/** After a failed read, counts are not asked for again this soon, so pages don't wait on it. */
const COUNTS_RETRY = 30_000;
/** Older counts are still shown while Tinylytics can't be read, up to this age. */
const COUNTS_STALE = 10 * 60_000;
/** How long a page waits on Tinylytics for the counts. */
const COUNTS_TIMEOUT = 2500;

/** The kudo uid for a player's heart on a sign. */
export const heartUid = (playerId: string, signId: string): string =>
  `rsm-${createHash('sha256').update(`heart\n${playerId}\n${signId}`).digest('hex').slice(0, 32)}`;

function logFailure(op: string, err: TinylyticsUnavailable): void {
  console.error({ event: 'tinylytics', op, outcome: err.off ? 'off' : 'unavailable', detail: err.message });
}

/** Turns a Tinylytics failure into the API's 503; any other error goes on as it is. */
function unavailable(op: string, err: unknown): never {
  if (!(err instanceof TinylyticsUnavailable)) throw err;
  logFailure(op, err);
  return fail('unavailable', 'Hearts couldn’t be counted just now. Try again in a minute.');
}

/**
 * Every sign's heart count, by path: one read of the site's kudos, kept a minute in memory.
 * Undefined when there is no Tinylytics or it can't be read and nothing recent is kept.
 */
export class HeartCounts {
  private cache?: { counts: Map<string, number>; startedAt: number; at: number };
  private loading?: Promise<void>;
  private failedAt = -Infinity;

  constructor(
    private readonly tinylytics: Tinylytics | undefined,
    private readonly now: () => number = Date.now
  ) {}

  private async load(): Promise<void> {
    const startedAt = this.now();
    try {
      const counts = new Map<string, number>();
      for (const k of await this.tinylytics!.kudos(undefined, COUNTS_TIMEOUT)) {
        counts.set(k.path, (counts.get(k.path) ?? 0) + 1);
      }
      this.cache = { counts, startedAt, at: this.now() };
    } catch (err) {
      this.failedAt = this.now();
      if (err instanceof TinylyticsUnavailable) logFailure('counts', err);
      else console.error({ event: 'tinylytics', op: 'counts', outcome: (err as Error).name });
    }
  }

  async counts(): Promise<Map<string, number> | undefined> {
    if (!this.tinylytics) return undefined;
    const now = this.now();
    if (this.cache && now - this.cache.at < COUNTS_FRESH) return this.cache.counts;
    if (now - this.failedAt >= COUNTS_RETRY) {
      this.loading ??= this.load().finally(() => (this.loading = undefined));
      await this.loading;
    }
    return this.cache && this.now() - this.cache.at < COUNTS_STALE ? this.cache.counts : undefined;
  }

  /**
   * Adds this server's own change to the kept counts, when they were read before the change began
   * (a read after it already has it).
   */
  adjust(path: string, delta: number, changeStartedAt: number): void {
    if (!this.cache || this.cache.startedAt >= changeStartedAt) return;
    this.cache.counts.set(path, Math.max(0, (this.cache.counts.get(path) ?? 0) + delta));
  }
}

export type HeartDeps = { store: Store; tinylytics?: Tinylytics; counts: HeartCounts };

/** The counts and, for a signed-in reader, the signs they hearted. */
export async function heartView(deps: HeartDeps, playerId: string | undefined): Promise<HeartView> {
  const [counts, mine] = await Promise.all([
    deps.counts.counts(),
    playerId ? deps.store.listHearts(playerId).then((h) => new Set(h.map((x) => x.signId))) : undefined
  ]);
  return { counts, mine };
}

export type HeartState = { hearted: boolean; hearts: number | null };

async function stateOf(deps: HeartDeps, sign: Sign, hearted: boolean): Promise<HeartState> {
  const counts = await deps.counts.counts();
  return { hearted, hearts: counts ? (counts.get(signPath(sign)) ?? 0) : null };
}

/**
 * Hearts the sign for the player (`on`) or takes their heart back. Doing what is already done
 * changes nothing and answers the same. Only a shown sign can be hearted; a heart can be taken
 * back from any sign the player can find.
 */
export async function setHeart(deps: HeartDeps, player: Player, sign: Sign, on: boolean): Promise<HeartState> {
  const { store, tinylytics, counts } = deps;
  if (on && !isPublic(sign)) fail('bad_request', 'Only a shown sign can be hearted');
  if (!!(await store.getHeart(player.id, sign.id)) === on) return stateOf(deps, sign, on);
  if (!tinylytics) return unavailable(on ? 'heart' : 'unheart', new TinylyticsUnavailable('No Tinylytics', true));

  // A holder for this request alone, so two of the player's own requests can't both hold it.
  const lease = `heart:${player.id}:${sign.id}`;
  const holder = randomUUID();
  if (!(await store.lease(lease, holder, 30))) fail('conflict', 'This heart is changing already. Try again.');
  try {
    // Read again under the lease: another request of this player's may have just done it.
    const heart = await store.getHeart(player.id, sign.id);
    if (!!heart === on) return await stateOf(deps, sign, on);
    const now = nowSeconds();
    await limit(
      store,
      `hearts:${player.id}`,
      LIMITS.heartsADay,
      DAY,
      now,
      'Too many hearts today. Try again tomorrow.'
    );
    const path = signPath(sign);
    const started = Date.now();
    if (on) {
      const uid = heartUid(player.id, sign.id);
      await store.putHeart({
        playerId: player.id,
        signId: sign.id,
        uid,
        createdAt: new Date(now * 1000).toISOString()
      });
      try {
        await tinylytics.addKudo(path, uid);
      } catch (err) {
        // It may have been made after all (an answer lost on the way back): take it back too. If
        // that fails as well, the row stays, so the heart shows as given and a later DELETE can
        // still take the kudo back.
        // With no key at all nothing was sent, so there is nothing to take back.
        const sent = !(err instanceof TinylyticsUnavailable && err.off);
        const undone =
          !sent ||
          (await tinylytics.removeKudo(uid).then(
            () => true,
            () => false
          ));
        if (undone) await store.deleteHeart(player.id, sign.id);
        return unavailable('heart', err);
      }
    } else {
      try {
        await tinylytics.removeKudo(heart!.uid);
      } catch (err) {
        return unavailable('unheart', err);
      }
      await store.deleteHeart(player.id, sign.id);
    }
    counts.adjust(path, on ? 1 : -1, started);
    return await stateOf(deps, sign, on);
  } finally {
    await store.endLease(lease, holder).catch(() => undefined);
  }
}

/**
 * Takes back every heart the player gave, kudo by kudo, before their account goes. A kudo that
 * can't be removed stops the delete with a 503, so the account is still there to try again.
 * With no key at all the kudos can't be reached: the rows go and the kudos stay, anonymous.
 */
export async function removePlayerHearts(deps: Omit<HeartDeps, 'counts'>, player: Player): Promise<void> {
  const { store, tinylytics } = deps;
  for (const heart of await store.listHearts(player.id)) {
    if (tinylytics) {
      try {
        await tinylytics.removeKudo(heart.uid);
      } catch (err) {
        if (!(err instanceof TinylyticsUnavailable && err.off)) unavailable('account-hearts', err);
        logFailure('account-hearts', err as TinylyticsUnavailable);
      }
    }
    await store.deleteHeart(player.id, heart.signId);
  }
}

/**
 * Removes every kudo on these signs' paths, the website's and the app's, before the signs are
 * deleted, so a later sign that gets the same slug starts at none. A failure stops the delete
 * with a 503; with no key there is nothing to reach, and the delete goes on.
 */
export async function removeSignKudos(deps: Omit<HeartDeps, 'counts'>, signs: Sign[]): Promise<void> {
  const { tinylytics } = deps;
  if (!tinylytics || !signs.length) return;
  const paths = new Set(signs.map(signPath));
  let kudos: Kudo[];
  try {
    kudos = await tinylytics.kudos(paths.size === 1 ? [...paths][0] : undefined);
    for (const k of kudos) if (paths.has(k.path)) await tinylytics.removeKudo(k.uid);
  } catch (err) {
    if (err instanceof TinylyticsUnavailable && err.off) return logFailure('sign-kudos', err);
    unavailable('sign-kudos', err);
  }
}
