// The website's pages are made on the server but almost never change, so CloudFront keeps them
// for a day (Popular six hours: its hearts come from Tinylytics without passing through here)
// and this clears them soon after something a page shows changes. A request that writes a sign,
// a way or a player clears the whole distribution after its last write, at most once a minute
// across the function's environments, with a trailing clear for a write inside that minute
// (`PageChanges`); a release clears it too (scripts/release.sh). The API's public reads stay at a
// minute and aren't affected.
//
// The clear is `/*`, one path however many pages there are (CloudFront's first 1,000 paths a
// month are free). It takes the photos under `/p/` with it; they are immutable and come back from
// S3 on the next view. A clear that fails is logged, owed and tried again; the request still
// answers, and the page is at most a day old, never wrong for longer.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { MiddlewareHandler } from 'hono';
import type { Store } from './store/store.ts';

/** How long CloudFront keeps a page (`s-maxage`); browsers keep it a minute. */
export const PAGE_CACHE = 'public, max-age=60, s-maxage=86400';
/** Popular's: its order follows hearts, and a website heart never passes through the server (Jamie, 2026-11-02: "at least 6 hours"). */
export const POPULAR_CACHE = 'public, max-age=60, s-maxage=21600';

/** Clears every page from the edge. */
export interface EdgeCache {
  clear(): Promise<void>;
}

export class CloudFrontEdgeCache implements EdgeCache {
  private readonly cdn = new CloudFrontClient({});
  constructor(private readonly distributionId: string) {}

  async clear(): Promise<void> {
    await this.cdn.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: { CallerReference: `site-${randomUUID()}`, Paths: { Quantity: 1, Items: ['/*'] } }
      })
    );
  }
}

/** For tests and `npm run dev`: counts the clears. */
export class MemoryEdgeCache implements EdgeCache {
  clears = 0;
  async clear(): Promise<void> {
    this.clears += 1;
  }
}

/**
 * The store's writes that change what a public page shows: signs, ways and players. Sessions,
 * logins, uploads, limits, leases, reports, blocks and hearts don't (a heart's count is
 * Tinylytics'; a report shows only when it hides a sign, which is `updateSign`).
 */
const PAGE_WRITES = [
  'putSign',
  'updateSign',
  'deleteSign',
  'moveSlug',
  'putWay',
  'deleteWay',
  'addWay',
  'addCoFind',
  'deleteCoFind',
  'putPlayer',
  'updatePlayer',
  'setAvatar',
  'deletePlayer'
] as const satisfies readonly (keyof Store)[];

const isPageWrite = (key: PropertyKey): boolean => (PAGE_WRITES as readonly PropertyKey[]).includes(key);

/** At most one clear a minute: the window lease's length. */
export const CLEAR_WINDOW_SECONDS = 60;
/** A write that lands inside the window is cleared this long after it, once the window is over. */
export const TRAILING_CLEAR_MS = (CLEAR_WINDOW_SECONDS + 2) * 1000;
/** How often each environment looks for a clear another one owed and could not send. */
export const OWED_SWEEP_MS = CLEAR_WINDOW_SECONDS * 1000;
/** The table's lease that says a clear went out in the last minute. */
export const CLEAR_LEASE = 'edge-clear';
/**
 * The table's lease that says a clear is owed. It lasts as long as the edge keeps a page: after
 * that every page it could have left stale has expired anyway.
 */
export const OWED_LEASE = 'edge-owed';
const OWED_HOLDER = 'owed';
const OWED_SECONDS = 86_400;

type Leases = Pick<Store, 'lease' | 'endLease'>;

/**
 * Clears the edge after a request that changed a page, at most once a minute across every
 * environment, and never leaves the last write stale.
 *
 * The minute is a lease in the table (`CLEAR_LEASE`), so it holds across the function's
 * environments. A request whose write lands while it is held owes a clear: it marks the table
 * (`OWED_LEASE`) and sets a timer in its own process for just after the window. When the timer
 * fires it takes the lease and clears; if another clear holds the lease by then, that one was
 * taken after this write (the lease held at the write had ended), so it covers it. Every clear
 * takes the owed mark down first, so a mark that stays is a write no clear has covered.
 *
 * The timer lives in one process, and Lambda can stop an environment at any time. So each
 * environment also looks at the mark on a request at most once a minute (`OWED_SWEEP_MS`, one
 * conditional write) and clears when it is up and the window is free. A failed clear marks the
 * table too, so it is tried again.
 *
 * Staleness: a write with no clear in the minute before it is cleared at once; one inside the
 * window about a minute later (at most two, when later writes push the timer). Only when its
 * environment stops before the timer fires does it wait for the next request to reach the
 * function a minute after the last look (crawlers' misses come every few minutes), and with no
 * such request at all, for the page's day at the edge, as when a clear fails outright.
 */
export class PageChanges {
  private readonly requests = new AsyncLocalStorage<{ changed: boolean }>();
  private leases?: Leases;
  private trailing?: ReturnType<typeof setTimeout>;
  private sweptAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly cache: EdgeCache) {}

  /**
   * The store, marking the request whenever one of its page writes runs, even one that fails
   * (a failed transaction may still have written). A write outside a request clears as soon as
   * the window allows. Its leases keep the window.
   */
  watch(store: Store): Store {
    this.leases = store;
    return new Proxy(store, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (!isPageWrite(key)) return value.bind(target);
        return async (...args: unknown[]) => {
          try {
            return await value.apply(target, args);
          } finally {
            this.changed();
          }
        };
      }
    });
  }

  /**
   * Runs each request with its own mark; after it, settles a change, or else looks for an owed
   * clear (at most once a minute).
   */
  middleware(): MiddlewareHandler {
    return (_c, next) => {
      const request = { changed: false };
      return this.requests.run(request, async () => {
        try {
          await next();
        } finally {
          await (request.changed ? this.settle() : this.sweep());
        }
      });
    };
  }

  private changed(): void {
    const request = this.requests.getStore();
    if (request) request.changed = true;
    else void this.settle();
  }

  /** After a write: clear now if the window is free, else owe a clear and time it for after. */
  private async settle(): Promise<void> {
    try {
      if (await this.tryClear()) return;
      if (this.trailing) clearTimeout(this.trailing);
      this.trailing = setTimeout(() => {
        this.trailing = undefined;
        void this.tryClear().catch((err: unknown) => this.failed(err));
      }, TRAILING_CLEAR_MS);
      this.trailing.unref?.();
      log('owed');
      await this.owe();
    } catch (err) {
      this.failed(err);
    }
  }

  /** At most once a minute: clears when another environment owed one it could not send. */
  private async sweep(): Promise<void> {
    if (!this.leases || Date.now() - this.sweptAt < OWED_SWEEP_MS) return;
    this.sweptAt = Date.now();
    try {
      // A lease for no time is taken only when no clear is owed, and leaves nothing behind.
      if (await this.leases.lease(OWED_LEASE, 'sweep', 0)) return;
      if (await this.tryClear()) log('swept');
    } catch (err) {
      this.failed(err);
    }
  }

  /** Takes the minute and clears; false when a clear already holds it. */
  private async tryClear(): Promise<boolean> {
    if (this.leases) {
      if (!(await this.leases.lease(CLEAR_LEASE, randomUUID(), CLEAR_WINDOW_SECONDS))) return false;
      // This clear covers every write before it, here or in any other environment.
      if (this.trailing) clearTimeout(this.trailing);
      this.trailing = undefined;
      // A mark this fails to take down only costs one more clear later.
      await this.leases.endLease(OWED_LEASE, OWED_HOLDER).catch(() => undefined);
    }
    try {
      await this.cache.clear();
      log('cleared');
    } catch (err) {
      this.failed(err);
      await this.owe().catch(() => undefined);
    }
    return true;
  }

  private async owe(): Promise<void> {
    await this.leases?.lease(OWED_LEASE, OWED_HOLDER, OWED_SECONDS);
  }

  private failed(err: unknown): void {
    console.error({ event: 'edge-cache', outcome: 'failed', detail: (err as Error).name });
  }
}

const log = (outcome: 'cleared' | 'owed' | 'swept'): void => console.info({ event: 'edge-cache', outcome });
