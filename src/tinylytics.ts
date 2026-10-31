// The server's side of Tinylytics (https://tinylytics.app/docs/api): hearts are kudos at a sign's
// path, and the iPhone app's screen views are hits. The website's own counting is the script in
// src/web/tinylytics.ts and needs no key; this needs the full-access key, TINYLYTICS_API_KEY in
// the runtime secret. Without the key every call fails as `off`, and hearts and app views go
// quietly without. The key never leaves this file: no error, log line or answer carries it, and a
// failure is described by its status code or its error's name alone.

/** The site's numeric id in Tinylytics (its public uid is in src/web/tinylytics.ts). */
export const TINYLYTICS_SITE_ID = 1525;

const BASE = 'https://tinylytics.app/api/v1';
/** Tinylytics refuses a request without a User-Agent. */
const USER_AGENT = 'roadsignmath.xyz (+https://roadsignmath.xyz)';
/** The first day a kudo can be on a sign: the hearts are as old as this server. */
export const KUDOS_SINCE = '2026-10-01';
/** Days in one kudos read; Tinylytics reads at most 730 days at a time. */
const WINDOW_DAYS = 700;
const PAGE = 1000;
/** How long a read key is trusted before it is read again, and how soon a missing one is looked for. */
const KEY_KEEP = 60 * 60 * 1000;
const KEY_RETRY = 5 * 60 * 1000;

export type Kudo = { uid: string; path: string };

/** One app screen view, as Tinylytics takes it from a server. */
export type Hit = { path: string; userAgent?: string; country?: string };

/**
 * An app screen's path: `/`, or one or two parts of lowercase letters, digits and hyphens, the
 * same as the website's page for that screen where it has one (`/signs/<slug>`).
 */
export const VIEW_PATH = /^\/(?:[a-z0-9-]{1,80}(?:\/[a-z0-9-]{1,80})?)?$/;

/** Marks the app's hits apart from the website's in Tinylytics' sources. */
export const APP_SOURCE = 'ios-app';

/** Tinylytics couldn't be asked: no key (`off`), or it failed or didn't answer in time. */
export class TinylyticsUnavailable extends Error {
  constructor(
    message: string,
    readonly off = false
  ) {
    super(message);
  }
}

export interface Tinylytics {
  /** Adds a kudo with this uid at the path. */
  addKudo(path: string, uid: string, timeoutMs?: number): Promise<void>;
  /** Removes the kudo with this uid; one already gone counts as removed. */
  removeKudo(uid: string, timeoutMs?: number): Promise<void>;
  /** Every kudo on the site since KUDOS_SINCE, or only those at `path`. */
  kudos(path?: string, timeoutMs?: number): Promise<Kudo[]>;
  /** Counts the app's screen views. */
  addHits(hits: Hit[], timeoutMs?: number): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** [start, end] dates from `since` to `today`, each at most WINDOW_DAYS long. */
export function kudoWindows(since: string, today: string): [string, string][] {
  const out: [string, string][] = [];
  const end = Date.parse(`${today}T00:00:00Z`);
  for (let start = Date.parse(`${since}T00:00:00Z`); start <= end; start += WINDOW_DAYS * 86400_000) {
    out.push([day(start), day(Math.min(end, start + (WINDOW_DAYS - 1) * 86400_000))]);
  }
  return out;
}

/** The live client: reads the key when first needed, and again now and then. */
export class KeyedTinylytics implements Tinylytics {
  private key?: { value: Promise<string | undefined>; until: number };

  constructor(
    private readonly readKey: () => Promise<string | undefined>,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
    private readonly site = TINYLYTICS_SITE_ID,
    private readonly now: () => number = Date.now
  ) {}

  private async apiKey(): Promise<string> {
    const now = this.now();
    if (!this.key || this.key.until <= now) this.key = { value: this.readKey(), until: now + KEY_KEEP };
    let key: string | undefined;
    try {
      key = await this.key.value;
    } catch (err) {
      this.key = undefined;
      // The error's name only: a message from reading the secret is never logged.
      console.error({ event: 'tinylytics-key', outcome: (err as Error).name });
      throw new TinylyticsUnavailable('The Tinylytics key could not be read');
    }
    if (!key) {
      this.key.until = Math.min(this.key.until, now + KEY_RETRY);
      throw new TinylyticsUnavailable('There is no Tinylytics key', true);
    }
    return key;
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number) {
    // One deadline for the whole call, reading the key included.
    const signal = AbortSignal.timeout(timeoutMs);
    const late = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new TinylyticsUnavailable('The Tinylytics key took too long')), {
        once: true
      })
    );
    late.catch(() => undefined);
    const key = await Promise.race([this.apiKey(), late]);
    let res: Response;
    try {
      res = await this.fetcher(`${BASE}/sites/${this.site}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (err) {
      throw new TinylyticsUnavailable(`Tinylytics didn't answer (${(err as Error).name})`);
    }
    // A key that stopped working is read again on the next call, in case it was replaced.
    if (res.status === 401) this.key = undefined;
    const json = (await res.json().catch(() => undefined)) as unknown;
    return { status: res.status, json };
  }

  private static failed(what: string, status: number): never {
    throw new TinylyticsUnavailable(`Tinylytics answered ${status} to ${what}`);
  }

  async addKudo(path: string, uid: string, timeoutMs = 4000): Promise<void> {
    const { status } = await this.call('POST', '/kudos', { path, custom_uid: uid }, timeoutMs);
    // 202 means Tinylytics ignored it (an ignore rule), so no kudo was made.
    if (status !== 201) KeyedTinylytics.failed('a new kudo', status);
  }

  async removeKudo(uid: string, timeoutMs = 4000): Promise<void> {
    const { status } = await this.call('DELETE', `/kudos/${encodeURIComponent(uid)}`, undefined, timeoutMs);
    if (status !== 200 && status !== 404) KeyedTinylytics.failed('removing a kudo', status);
  }

  async kudos(path?: string, timeoutMs = 4000): Promise<Kudo[]> {
    const out: Kudo[] = [];
    for (const [start, end] of kudoWindows(KUDOS_SINCE, day(this.now()))) {
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({
          start_date: start,
          end_date: end,
          per_page: String(PAGE),
          page: String(page),
          ...(path ? { path } : {})
        });
        const { status, json } = await this.call('GET', `/kudos?${query}`, undefined, timeoutMs);
        if (status !== 200) KeyedTinylytics.failed('reading kudos', status);
        const answer = json as { kudos?: { uid?: unknown; path?: unknown }[]; pagination?: { total_pages?: unknown } };
        if (!Array.isArray(answer?.kudos)) KeyedTinylytics.failed('reading kudos (no list)', status);
        for (const k of answer.kudos!) {
          if (typeof k?.uid === 'string' && typeof k.path === 'string') out.push({ uid: k.uid, path: k.path });
        }
        const pages = Number(answer.pagination?.total_pages ?? 1);
        if (!(page < pages) || answer.kudos!.length === 0) break;
      }
    }
    return out;
  }

  async addHits(hits: Hit[], timeoutMs = 2000): Promise<void> {
    if (!hits.length) return;
    const rows = hits.map((h) => ({
      path: h.path,
      source: APP_SOURCE,
      ...(h.userAgent ? { user_agent: h.userAgent } : {}),
      ...(h.country ? { country: h.country } : {})
    }));
    const { status } = await this.call('POST', '/hits/batch', rows, timeoutMs);
    if (status !== 200) KeyedTinylytics.failed('app views', status);
  }
}
