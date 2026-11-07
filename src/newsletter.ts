// The players' newsletter on Buttondown (https://docs.buttondown.com/api-subscribers-create).
// Jamie, 2026-11-07: "include ALL players that we have in the system, add new players when they
// create account, delete players if they remove themselves". A new player is added on their first
// sign-in, and a player who deletes their account is removed. The key is BUTTONDOWN_API_KEY in the
// runtime secret; without it every call is `off` and nothing changes.
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

export interface Newsletter {
  add(email: string, timeoutMs?: number): Promise<AddOutcome>;
  remove(email: string, timeoutMs?: number): Promise<RemoveOutcome>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

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
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  }

  async add(email: string, timeoutMs = 4000): Promise<AddOutcome> {
    try {
      const status = await this.call('POST', '/subscribers', { email_address: email, type: 'regular' }, timeoutMs);
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

  async add(email: string): Promise<AddOutcome> {
    if (this.list.has(email) || this.unsubscribed.has(email)) return 'known';
    this.list.add(email);
    return 'added';
  }

  async remove(email: string): Promise<RemoveOutcome> {
    const had = this.list.delete(email) || this.unsubscribed.delete(email);
    return had ? 'removed' : 'gone';
  }
}
