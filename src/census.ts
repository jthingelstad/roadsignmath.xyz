// The hourly census: one `census` log line with the game's totals, for the product dashboard's
// lines over time (otto-ops `grafana/dashboards/road-sign-math-product.json`). Counts only:
// never a player, a sign, an email or an address.
//
// There is no scheduler. Whichever request first wins the hour's lease (`LEASE#census`, one
// conditional write in the table, kept an hour) counts and logs. An instance asks for the lease
// at most every `CENSUS_RETRY` seconds, so most requests do nothing at all. The count runs beside
// the request rather than after it, the request waits for it at most `CENSUS_WAIT_MS` past its own
// answer, and anything that goes wrong is swallowed: the census never fails a request or changes
// its answer.
//
// Cost, at about 50 players and 180 signs: an instance's lease tries are at most 12 an hour (one
// write each, refused or not), and the count, once an hour, reads the signs and players
// partitions, then one query per sign for its ways and co-finds and one per player for their
// live sessions, about 400 small reads. Together well under a cent a month.

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { isPublic } from './api/views.ts';
import type { Store } from './store/store.ts';
import { nowSeconds } from './store/store.ts';

/** How long the hour's lease is held: one census an hour at most, across every instance. */
export const CENSUS_EVERY = 3600;
/** How often one instance asks for the lease. */
export const CENSUS_RETRY = 300;
/**
 * How long a request waits, after its own answer is ready, for a count still running beside it.
 * The count usually finishes first; a slow or stuck one goes on without the request.
 */
export const CENSUS_WAIT_MS = 1000;
/** Reads in flight at once while counting. */
const AT_ONCE = 16;

export type CensusLine = {
  event: 'census';
  players: number;
  /** Players who have given a name (the first step after signing in). */
  playersNamed: number;
  /** Players who posted a sign, wrote a way or found one too. */
  playersPlaying: number;
  /** Players with a live session from the app, from Quiz, and from both. */
  playersApp: number;
  playersQuiz: number;
  playersBoth: number;
  signsShown: number;
  signsHeld: number;
  signsHidden: number;
  /** Shown signs found 2005 to 2014 (the first era), and since. */
  signsFirstEra: number;
  signsNewEra: number;
  /** Ways on shown signs, and players crediting themselves on a way already there. */
  ways: number;
  coFinds: number;
  /** Shown signs with no way yet, and with exactly one. */
  signsUnsolved: number;
  signsOneWay: number;
};

/** Every item through `work`, `AT_ONCE` at a time, in order. */
async function each<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** Counts the game as it is now. */
export async function countCensus(store: Store): Promise<CensusLine> {
  const [signs, players] = await Promise.all([store.allSigns(), store.allPlayers()]);
  const shown = signs.filter(isPublic);
  const onSigns = await each(shown, async (s) => {
    const [ways, coFinds] = await Promise.all([store.listWays(s.id), store.listCoFinds(s.id)]);
    return { ways, coFinds };
  });
  const sessions = await each(players, (p) => store.sessionsOf(p.id));
  const playing = new Set<string>(signs.map((s) => s.postedBy));
  for (const { ways, coFinds } of onSigns) {
    for (const w of ways) playing.add(w.playerId);
    for (const c of coFinds) playing.add(c.playerId);
  }
  let app = 0;
  let quiz = 0;
  let both = 0;
  for (const list of sessions) {
    const inApp = list.some((s) => (s.via ?? 'app') === 'app');
    const inQuiz = list.some((s) => s.via === 'quiz');
    if (inApp) app++;
    if (inQuiz) quiz++;
    if (inApp && inQuiz) both++;
  }
  const firstEra = shown.filter((s) => s.foundOn < '2015').length;
  return {
    event: 'census',
    players: players.length,
    playersNamed: players.filter((p) => p.name).length,
    playersPlaying: players.filter((p) => playing.has(p.id)).length,
    playersApp: app,
    playersQuiz: quiz,
    playersBoth: both,
    signsShown: shown.length,
    signsHeld: signs.filter((s) => s.visibility === 'held').length,
    signsHidden: signs.filter((s) => s.visibility === 'hidden').length,
    signsFirstEra: firstEra,
    signsNewEra: shown.length - firstEra,
    ways: onSigns.reduce((n, o) => n + o.ways.length, 0),
    coFinds: onSigns.reduce((n, o) => n + o.coFinds.length, 0),
    signsUnsolved: onSigns.filter((o) => o.ways.length === 0).length,
    signsOneWay: onSigns.filter((o) => o.ways.length === 1).length
  };
}

/**
 * The census for one server instance. `middleware()` goes outside everything else in
 * `createApp`; `run()` is what it does, for tests.
 */
export class Census {
  private nextTry = 0;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = nowSeconds,
    private readonly log: (line: CensusLine) => void = (line) => console.info(line),
    private readonly waitMs: number = CENSUS_WAIT_MS
  ) {}

  /** Takes the hour's lease if it is free and this instance hasn't asked lately, then counts. */
  async run(): Promise<'counted' | 'held' | 'waiting' | 'failed'> {
    const now = this.now();
    if (now < this.nextTry) return 'waiting';
    this.nextTry = now + CENSUS_RETRY;
    try {
      if (!(await this.store.lease('census', randomUUID(), CENSUS_EVERY))) return 'held';
      this.log(await countCensus(this.store));
      return 'counted';
    } catch {
      return 'failed';
    }
  }

  middleware(): MiddlewareHandler {
    return async (_c, next) => {
      const counting = this.run().catch(() => 'failed' as const);
      try {
        await next();
      } finally {
        // Lambda may pause the instance once the answer is out, so the count gets a short while to
        // finish first; it never holds the answer longer than that.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const enough = new Promise<void>((done) => {
          timer = setTimeout(done, this.waitMs);
        });
        await Promise.race([counting, enough]);
        clearTimeout(timer);
      }
    };
  }
}
