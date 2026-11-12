// The players' newsletter on Buttondown (https://docs.buttondown.com/api-subscribers-create).
// Jamie, 2026-11-07: "include ALL players that we have in the system, add new players when they
// create account, delete players if they remove themselves". A new player is added on their first
// sign-in, and a player who deletes their account is removed. The key is BUTTONDOWN_API_KEY in the
// runtime secret; without it every call is `off` and nothing changes.
//
// Tags (Jamie, 2026-11-12: "Approved: add Buttondown tags for Quiz players and tag the existing list
// once"): `app` and `quiz` say where a player has signed in, `first-era` marks the 2005-2014 players
// from the archive. A new player is added with the tag of where they signed in; one already on the
// list is tagged by reading their tags and writing them back with ours added, since Buttondown's
// update replaces the whole list (https://docs.buttondown.com/openapi.json, PATCH
// /subscribers/{id_or_email}). Tags are only ever added, never taken off.
//
// Never resubscribed: an add sends no X-Buttondown-Collision-Behavior header, so Buttondown answers
// 400 for an address it already has, unsubscribed ones included, and changes nothing. Never log an
// address or the key: an outcome is described by its status code or its error's name alone.

const BASE = 'https://api.buttondown.com/v1';
const KEY_KEEP = 60 * 60 * 1000;
const KEY_RETRY = 5 * 60 * 1000;

/** `added` is new on the list; `known` means Buttondown already had the address and kept it as it was. */
export type AddOutcome = 'added' | 'known' | 'off' | 'failed';
/** `gone` means Buttondown had no such address. */
export type RemoveOutcome = 'removed' | 'gone' | 'off' | 'failed';
/** `already` means the subscriber had every tag; `gone` means Buttondown has no such address. */
export type TagOutcome = 'tagged' | 'already' | 'gone' | 'off' | 'failed';

/** Where a player signs in (`app`, `quiz`), and the archive's players from 2005 to 2014. */
export type NewsletterTag = 'app' | 'quiz' | 'first-era';

export interface Newsletter {
  add(email: string, tags?: NewsletterTag[], timeoutMs?: number): Promise<AddOutcome>;
  /** Adds the tags to a subscriber Buttondown already has, keeping the tags they have. */
  tag(email: string, tags: NewsletterTag[], timeoutMs?: number): Promise<TagOutcome>;
  remove(email: string, timeoutMs?: number): Promise<RemoveOutcome>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The `code` of a Buttondown error answer, if it has one. Reads the body. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const code: unknown = ((await res.json()) as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** The live client: reads the key when first needed, and again now and then. */
export class Buttondown implements Newsletter {
  private key?: { value: Promise<string | undefined>; until: number };

  constructor(
    private readonly readKey: () => Promise<string | undefined>,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now
  ) {}

  private async apiKey(): Promise<string | undefined> {
    const now = this.now();
    if (!this.key || this.key.until <= now) this.key = { value: this.readKey(), until: now + KEY_KEEP };
    try {
      const key = await this.key.value;
      if (!key) this.key.until = Math.min(this.key.until, now + KEY_RETRY);
      return key;
    } catch (err) {
      this.key = undefined;
      console.error({ event: 'newsletter-key', outcome: (err as Error).name });
      throw err;
    }
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<number | 'off'> {
    const res = await this.send(method, path, body, timeoutMs);
    if (res === 'off') return 'off';
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  }

  private async send(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response | 'off'> {
    const key = await this.apiKey();
    if (!key) return 'off';
    const res = await this.fetcher(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Token ${key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    // A key that stopped working is read again next time, in case it was replaced.
    if (res.status === 401) this.key = undefined;
    return res;
  }

  async add(email: string, tags: NewsletterTag[] = [], timeoutMs = 4000): Promise<AddOutcome> {
    try {
      const subscriber = { email_address: email, type: 'regular', ...(tags.length ? { tags } : {}) };
      const res = await this.send('POST', '/subscribers', subscriber, timeoutMs);
      const status = res === 'off' ? 'off' : res.status;
      const code = res !== 'off' && status === 400 ? await errorCode(res) : undefined;
      if (res !== 'off' && code === undefined) await res.body?.cancel().catch(() => undefined);
      // Tags Buttondown won't take never keep a player off the list: they are added untagged.
      if (code === 'tag_invalid' && tags.length) {
        console.error({ event: 'newsletter', op: 'add', outcome: 'untagged', detail: code });
        return this.add(email, [], timeoutMs);
      }
      const outcome: AddOutcome =
        status === 'off'
          ? 'off'
          : status === 201 || status === 200
            ? 'added'
            : status === 400 || status === 409
              ? 'known'
              : 'failed';
      if (outcome === 'failed') console.error({ event: 'newsletter', op: 'add', outcome, status });
      return outcome;
    } catch (err) {
      console.error({ event: 'newsletter', op: 'add', outcome: 'failed', detail: (err as Error).name });
      return 'failed';
    }
  }

  async tag(email: string, tags: NewsletterTag[], timeoutMs = 4000): Promise<TagOutcome> {
    const path = `/subscribers/${encodeURIComponent(email)}`;
    const failed = (detail: number | string): TagOutcome => {
      console.error({ event: 'newsletter', op: 'tag', outcome: 'failed', detail });
      return 'failed';
    };
    try {
      const read = await this.send('GET', path, undefined, timeoutMs);
      if (read === 'off') return 'off';
      if (read.status !== 200) {
        await read.body?.cancel().catch(() => undefined);
        return read.status === 404 ? 'gone' : failed(read.status);
      }
      // The answer holds the address: it is read for its tags and goes no further.
      const have: unknown = ((await read.json()) as { tags?: unknown }).tags;
      if (!Array.isArray(have) || !have.every((t) => typeof t === 'string')) return failed('no tags');
      const missing = tags.filter((t) => !have.includes(t));
      if (!missing.length) return 'already';
      const status = await this.call('PATCH', path, { tags: [...have, ...missing] }, timeoutMs);
      if (status === 'off') return 'off';
      if (status === 200) return 'tagged';
      return status === 404 ? 'gone' : failed(status);
    } catch (err) {
      return failed((err as Error).name);
    }
  }

  async remove(email: string, timeoutMs = 4000): Promise<RemoveOutcome> {
    try {
      const status = await this.call('DELETE', `/subscribers/${encodeURIComponent(email)}`, undefined, timeoutMs);
      const outcome: RemoveOutcome =
        status === 'off' ? 'off' : status === 204 || status === 200 ? 'removed' : status === 404 ? 'gone' : 'failed';
      if (outcome === 'failed') console.error({ event: 'newsletter', op: 'remove', outcome, status });
      return outcome;
    } catch (err) {
      console.error({ event: 'newsletter', op: 'remove', outcome: 'failed', detail: (err as Error).name });
      return 'failed';
    }
  }
}

/** For tests and `npm run dev`: remembers who is on the list, sends nothing. */
export class MemoryNewsletter implements Newsletter {
  readonly list = new Set<string>();
  /** Addresses that unsubscribed: Buttondown keeps them, and an add leaves them unsubscribed. */
  readonly unsubscribed = new Set<string>();
  /** Each address's tags, subscribed or not. */
  readonly tags = new Map<string, Set<string>>();

  async add(email: string, tags: NewsletterTag[] = []): Promise<AddOutcome> {
    if (this.list.has(email) || this.unsubscribed.has(email)) return 'known';
    this.list.add(email);
    this.tags.set(email, new Set(tags));
    return 'added';
  }

  async tag(email: string, tags: NewsletterTag[]): Promise<TagOutcome> {
    if (!this.list.has(email) && !this.unsubscribed.has(email)) return 'gone';
    const have = this.tags.get(email) ?? new Set<string>();
    this.tags.set(email, have);
    if (tags.every((t) => have.has(t))) return 'already';
    for (const t of tags) have.add(t);
    return 'tagged';
  }

  async remove(email: string): Promise<RemoveOutcome> {
    const had = this.list.delete(email) || this.unsubscribed.delete(email);
    this.tags.delete(email);
    return had ? 'removed' : 'gone';
  }
}
