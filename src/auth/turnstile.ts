// Cloudflare Turnstile on the website's and Quiz's sign-in form, the one web form that emails a
// typed address. From 21 to 28 November 2026 a crawler loaded the website's form 40 times and
// posted each 0.7 to 1.8 seconds later with an address of its own making: 40 sign-in emails, no
// sign-in finished, under every limit. The pause (src/quiz/pause.ts) came first; Turnstile is the
// pattern the owner's other sites use (Jamie, 2026-11-28: "our pattern is using Turnstile on other
// sites. Lets also make sure our observability tools can see turnstile success too."). This is
// Release Notes' check, made for a server-drawn form.
//
// Modes (`TURNSTILE_MODE` in the stack's environment, from the `TurnstileMode` parameter):
// - `observe`, the default: the widget is drawn, every post is checked and logged, nobody refused.
// - `enforce`: a post whose token is missing or that Cloudflare rejected sends no email. A post
//   Cloudflare can't be asked about (`error`: a timeout, an outage, a secret it rejects) goes
//   ahead, as does every post while there is no secret (`unconfigured`): the pause and the limits
//   in src/auth/auth.ts stay behind it, and nobody is locked out by our own plumbing.
// - `off`: no widget and no check; each post still logs `off`.
//
// The secret is `TURNSTILE_SECRET_KEY` in the runtime secret (src/secrets.ts), which the owner
// adds by hand; until it is there every post logs `unconfigured` and goes ahead in any mode. The
// iPhone app's `POST /auth/start` can't carry a widget and isn't checked.
//
// Cloudflare's own rule for siteverify is to check where and for what a token was made, not only
// that it is good: a pass whose `hostname` is not one the widget is on (the site, its www and Quiz,
// from the configured origins, `widgetHostnames`) or whose `action` is not the posting front's
// (`turnstileAction`: `signin-site` or `signin-quiz`) is a `fail`, with `hostname-mismatch` or
// `action-mismatch` among its codes. Enforce refuses it like any rejected token.
//
// One line per checked post (`event: 'turnstile'`), never the token or the address. The page's
// `client_reason` and `client_wait_ms` are its own word: logged, never trusted.

/** Widget "Road Sign Math sign-in" (managed; roadsignmath.xyz, www and quiz). Public: every sign-in page shows it. */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAGXFwwVmY7mALKs3';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Cloudflare's script, rendered explicitly by the page's own script (src/quiz/turnstile.ts). */
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/** Flip to `enforce` only once the observe numbers show people pass: the owner's call. */
export const DEFAULT_TURNSTILE_MODE: TurnstileMode = 'observe';
/** How long siteverify gets before the post goes on as `error`. */
export const VERIFY_TIMEOUT_MS = 3000;
/** How long the secret is kept once read; a missing one is asked for again sooner. */
const SECRET_KEEP = 60 * 60 * 1000;
const SECRET_RETRY = 5 * 60 * 1000;

export type TurnstileMode = 'off' | 'observe' | 'enforce';
/**
 * pass / fail: Cloudflare's answer. missing: the form came without a token. error: Cloudflare, or
 * the secret, could not be read. unconfigured: no secret yet. off: not checked.
 */
export type TurnstileResult = 'pass' | 'fail' | 'missing' | 'error' | 'unconfigured' | 'off';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type TurnstileConfig = {
  mode: TurnstileMode;
  /** The widget's public key, drawn on the sign-in page. */
  siteKey: string;
  /** The widget's secret, or undefined while there is none. Throws when it can't be read. */
  secret: () => Promise<string | undefined>;
  /** Cloudflare's siteverify; tests give a fake. */
  fetch?: Fetch;
  timeoutMs?: number;
};

/** Where and for what a good token must have been made: the widget's hostnames, and the front's action. */
export type TurnstileExpect = { hostnames: readonly string[]; action: string };

/** The action each front's widget is drawn with (src/quiz/pages.tsx), and the one its posts must carry. */
export const turnstileAction = (front: 'site' | 'quiz'): string => `signin-${front}`;

/**
 * The hostnames the widget is drawn on, from the site's and Quiz's origins: the site, its www (the
 * widget is set up for it; the edge sends www to the apex) and Quiz. Lowercase, as Cloudflare gives them.
 */
export function widgetHostnames(site: string, quiz: string): string[] {
  const host = (origin: string) => new URL(origin).hostname.toLowerCase();
  const apex = host(site);
  return [...new Set([apex, `www.${apex}`, host(quiz)])];
}

export type TurnstileVerdict = {
  result: TurnstileResult;
  mode: TurnstileMode;
  /** Whether the sign-in may go on. Always true outside enforce. */
  allowed: boolean;
  codes: string[];
  hostname?: string;
  action?: string;
};

export function turnstileMode(raw?: string): TurnstileMode {
  const mode = String(raw ?? '')
    .trim()
    .toLowerCase();
  return mode === 'off' || mode === 'observe' || mode === 'enforce' ? mode : DEFAULT_TURNSTILE_MODE;
}

/** Enforce refuses only a token that is absent or that Cloudflare rejected. */
export function turnstileAllows(mode: TurnstileMode, result: TurnstileResult): boolean {
  return mode !== 'enforce' || (result !== 'fail' && result !== 'missing');
}

/** The site key to draw a widget with, or undefined when no widget is drawn (none set up, or off). */
export const widgetKey = (config: TurnstileConfig | undefined): string | undefined =>
  config && config.mode !== 'off' && config.siteKey ? config.siteKey : undefined;

/**
 * Reads a secret once an hour at most (and a missing one every five minutes), so a sign-in costs no
 * Secrets Manager call. An error is not kept: the next post asks again.
 */
export function keptSecret(
  read: () => Promise<string | undefined>,
  now: () => number = Date.now
): () => Promise<string | undefined> {
  let kept: { value: Promise<string | undefined>; until: number } | undefined;
  return async () => {
    const at = now();
    if (!kept || kept.until <= at) kept = { value: read(), until: at + SECRET_KEEP };
    const mine = kept;
    try {
      const value = await mine.value;
      if (!value) mine.until = Math.min(mine.until, at + SECRET_RETRY);
      return value;
    } catch (err) {
      if (kept === mine) kept = undefined;
      throw err;
    }
  };
}

/** The form's token: the page's script puts it in `turnstile_token`. Cloudflare documents 2048 characters at most. */
export function turnstileToken(field: (key: string) => string): string {
  return (field('turnstile_token') || field('cf-turnstile-response')).trim().slice(0, 2048);
}

/**
 * What the page says about its own token: why it has none (`turnstile_reason`: `no-script` is the
 * form's own value, which the script replaces) and how long it waited (`turnstile_wait_ms`).
 * Logged beside the verdict only: a bot can say anything, so a reason never lets anything through.
 */
export function turnstileClient(field: (key: string) => string): { client_reason?: string; client_wait_ms?: number } {
  const reason = field('turnstile_reason').trim();
  const wait = field('turnstile_wait_ms').trim();
  const ms = /^[0-9]{1,9}$/.test(wait) ? Math.min(Number(wait), 600_000) : undefined;
  return {
    ...(reason ? { client_reason: /^[a-z0-9:-]{1,40}$/.test(reason) ? reason : 'other' } : {}),
    ...(ms !== undefined ? { client_wait_ms: ms } : {})
  };
}

async function siteverify(
  fetcher: Fetch,
  secret: string,
  token: string,
  viewer: string,
  timeoutMs: number
): Promise<{ result: 'pass' | 'fail' | 'error'; codes: string[]; hostname?: string; action?: string }> {
  const form = new URLSearchParams({ secret, response: token });
  if (/^[0-9a-f:.]{2,45}$/i.test(viewer)) form.set('remoteip', viewer);
  try {
    const response = await fetcher(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { result: 'error', codes: [`http-${response.status}`] };
    const data = (await response.json()) as {
      success?: unknown;
      'error-codes'?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    const codes = Array.isArray(data['error-codes'])
      ? data['error-codes']
          .map((code) =>
            String(code)
              .replace(/[^a-z0-9-]/gi, '')
              .slice(0, 40)
          )
          .slice(0, 5)
      : [];
    // A rejected secret is our fault and `internal-error` is Cloudflare's: neither says anything
    // about the visitor, so neither is a `fail`.
    if (data.success !== true && codes.some((code) => code.includes('secret') || code === 'internal-error'))
      return { result: 'error', codes };
    return {
      result: data.success === true ? 'pass' : 'fail',
      codes,
      ...(typeof data.hostname === 'string' ? { hostname: data.hostname.slice(0, 253) } : {}),
      ...(typeof data.action === 'string' ? { action: data.action.slice(0, 32) } : {})
    };
  } catch (err) {
    // A timeout is `TimeoutError`; the name only, never a message.
    return { result: 'error', codes: [(err as Error)?.name || 'Error'] };
  }
}

/** Checks one sign-in post's token. Never throws: the verdict says whether to go on and what to log. */
export async function checkTurnstile(input: {
  token: string;
  viewer: string;
  config: TurnstileConfig;
  /** What a pass must say: a token made elsewhere, or for the other front, is a `fail`. */
  expect: TurnstileExpect;
}): Promise<TurnstileVerdict> {
  const { config } = input;
  const mode = config.mode;
  const done = (result: TurnstileResult, codes: string[] = [], extra: { hostname?: string; action?: string } = {}) => ({
    result,
    mode,
    allowed: turnstileAllows(mode, result),
    codes,
    ...extra
  });
  if (mode === 'off') return done('off');
  // The secret first: without one nothing can be verified, so every post reads `unconfigured`
  // and goes ahead in any mode, a token or not.
  let secret: string | undefined;
  try {
    secret = await config.secret();
  } catch (err) {
    return done('error', ['secret-' + ((err as Error)?.name || 'Error').slice(0, 32)]);
  }
  if (!secret) return done('unconfigured');
  if (!input.token) return done('missing');
  const { result, codes, ...extra } = await siteverify(
    config.fetch ?? ((url, init) => fetch(url, init)),
    secret,
    input.token,
    input.viewer,
    config.timeoutMs ?? VERIFY_TIMEOUT_MS
  );
  if (result === 'pass') {
    // Cloudflare vouches for the token; these say whether it was made here, for this form.
    const mismatch = [
      ...(input.expect.hostnames.includes(extra.hostname?.toLowerCase() ?? '') ? [] : ['hostname-mismatch']),
      ...(extra.action === input.expect.action ? [] : ['action-mismatch'])
    ];
    if (mismatch.length) return done('fail', [...codes, ...mismatch], extra);
  }
  return done(result, codes, extra);
}

/** The one log line for a checked post: counts and small words only, never the token or the address. */
export function turnstileLine(
  verdict: TurnstileVerdict,
  front: 'site' | 'quiz',
  client: { client_reason?: string; client_wait_ms?: number }
): Record<string, string | number | boolean> {
  return {
    event: 'turnstile',
    result: verdict.result,
    mode: verdict.mode,
    allowed: verdict.allowed,
    front,
    codes: verdict.codes.join(','),
    ...(verdict.hostname ? { hostname: verdict.hostname } : {}),
    ...(verdict.action ? { action: verdict.action } : {}),
    ...client
  };
}

/** Where the lines go: the function's log. Quiet under `node --test`; a test that reads them puts its own `write` here. */
export const turnstileLog = {
  write: process.env.NODE_TEST_CONTEXT
    ? (_line: Record<string, unknown>) => {}
    : (line: Record<string, unknown>) => console.info(line)
};
