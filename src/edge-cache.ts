// The website's pages are made on the server but almost never change, so CloudFront keeps them
// for a day (Popular six hours: its hearts come from Tinylytics without passing through here)
// and this clears them the moment something a page shows changes. A request that writes a sign,
// a way or a player clears the whole distribution once, after its last write; a release clears
// it too (scripts/release.sh). The API's public reads stay at a minute and aren't affected.
//
// The clear is `/*`, one path however many pages there are (CloudFront's first 1,000 paths a
// month are free). It takes the photos under `/p/` with it; they are immutable and come back from
// S3 on the next view. A clear that fails is logged and the request still answers: the page is
// at most a day old, never wrong for longer.

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

/** Clears the edge once per request that changed a page, after the request is done. */
export class PageChanges {
  private readonly requests = new AsyncLocalStorage<{ changed: boolean }>();
  constructor(private readonly cache: EdgeCache) {}

  /**
   * The store, marking the request whenever one of its page writes runs, even one that fails
   * (a failed transaction may still have written). A write outside a request clears at once.
   */
  watch(store: Store): Store {
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

  /** Runs each request with its own mark and clears after it when the mark is set. */
  middleware(): MiddlewareHandler {
    return (_c, next) => {
      const request = { changed: false };
      return this.requests.run(request, async () => {
        try {
          await next();
        } finally {
          if (request.changed) await this.clear();
        }
      });
    };
  }

  private changed(): void {
    const request = this.requests.getStore();
    if (request) request.changed = true;
    else void this.clear();
  }

  private async clear(): Promise<void> {
    try {
      await this.cache.clear();
      console.info({ event: 'edge-cache', outcome: 'cleared' });
    } catch (err) {
      console.error({ event: 'edge-cache', outcome: 'failed', detail: (err as Error).name });
    }
  }
}
