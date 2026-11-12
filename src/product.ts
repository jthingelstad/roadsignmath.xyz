// The product's own log lines, for the Road Sign Math product dashboard in Grafana (otto-ops
// `grafana/dashboards/road-sign-math-product.json`, through Logs Insights on the function's log).
//
// `product`: one line each time a player does something (signs in, posts a sign, finds a way,
// hearts a sign, reports one, changes their profile, leaves). Counts and small words only: never
// an email, a name, a handle, a player or sign id, an address or anything a player typed. The
// fields and the words each may hold are `PRODUCT_FIELDS`, which a test pins, and `productLine`
// drops anything else, so a later change can't slip a person into the log.
//
// `failure`: a counted line for each thing the Operator reads in the morning that went wrong for
// a player, by kind and outcome only (`FAILURES`). Some failures have their own lines from before
// and keep them: `report-mail` (src/reports.ts), `limited` with `limit: 'total'` for the sign-in
// cap (src/api/input.ts; the stack's SignInTotalLimited metric reads it) and `moderator-key`.

/** Where a player did it: the iPhone app (the API), Quiz, or the website. */
export type Front = 'app' | 'quiz' | 'site';

export type ProductLine =
  | { action: 'signin-start'; front: Front }
  | { action: 'signin-finish'; front: Front; outcome: 'new' | 'returning' }
  | { action: 'sign'; front: Front; outcome: 'shown' | 'held'; photos: number; numbers: number; solved: boolean }
  | { action: 'way'; front: Front; outcome: 'new' | 'found-too' }
  | { action: 'skip'; front: Front; guest?: boolean }
  | { action: 'signin-ask'; front: Front }
  | { action: 'heart'; front: Front; outcome: 'given' | 'taken-back' }
  | { action: 'report'; front: Front; outcome: 'hidden' | 'kept' }
  | { action: 'duplicate'; front: Front }
  | {
      action: 'profile';
      part: 'name' | 'bio' | 'name-and-bio' | 'website' | 'home' | 'several' | 'photo' | 'photo-removed';
      first?: boolean;
    }
  | { action: 'photo-refused' }
  | { action: 'words-refused'; first: boolean }
  | { action: 'player-report'; front: Front }
  | { action: 'finder-left'; front: Front }
  | { action: 'account-deleted' }
  | { action: 'feedback'; front: Front };

const FRONTS = ['app', 'quiz', 'site'] as const;

/**
 * Every field a `product` line may carry and what it may hold: a list of words, `count` (a whole
 * number from 0 to 1,000), or `flag` (true or false). `first` is a player's first name given.
 * `guest` marks a Quiz skip by someone not signed in, and `signin-ask` is a signed-out Send in
 * Quiz that asked them to sign in (their math kept with the sign-in, never logged).
 */
export const PRODUCT_FIELDS = {
  event: ['product'],
  action: [
    'signin-start',
    'signin-finish',
    'sign',
    'way',
    'skip',
    'signin-ask',
    'heart',
    'report',
    'duplicate',
    'profile',
    'photo-refused',
    'words-refused',
    'player-report',
    'finder-left',
    'account-deleted',
    'feedback'
  ],
  front: FRONTS,
  outcome: ['new', 'returning', 'shown', 'held', 'found-too', 'given', 'taken-back', 'hidden', 'kept'],
  part: ['name', 'bio', 'name-and-bio', 'website', 'home', 'several', 'photo', 'photo-removed'],
  photos: 'count',
  numbers: 'count',
  solved: 'flag',
  first: 'flag',
  guest: 'flag'
} as const satisfies Record<string, readonly string[] | 'count' | 'flag'>;

/** The kinds of failure the Operator counts, and the outcomes each logs. */
export const FAILURES = {
  /**
   * The moderator couldn't be asked (the post, report, photo or profile words answered 503), wouldn't look, or the
   * day's ceiling across all players was reached (`ceiling`: answered 503 the same way).
   */
  moderator: ['unavailable', 'refused', 'ceiling'],
  /** A sign-in email that didn't go: the start answers its error and no code reached the player. */
  'signin-mail': ['unsent']
} as const;

/** What a moderator call was for: the `op` on its failure lines. */
export const MODERATOR_OPS = ['post', 'report', 'avatar', 'profile'] as const;
export type ModeratorOp = (typeof MODERATOR_OPS)[number];

type Allowed = readonly string[] | 'count' | 'flag';

/** The line as it is logged: only the allowed fields, each only with what it may hold. */
export function productLine(line: ProductLine): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { event: 'product' };
  for (const [field, value] of Object.entries(line)) {
    const allowed = (PRODUCT_FIELDS as Record<string, Allowed>)[field];
    if (allowed === undefined || field === 'event') continue;
    if (allowed === 'count') {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000) out[field] = value;
    } else if (allowed === 'flag') {
      if (typeof value === 'boolean') out[field] = value;
    } else if (typeof value === 'string' && allowed.includes(value)) {
      out[field] = value;
    }
  }
  return out;
}

/**
 * Where `product` lines go: the function's log. Quiet under `node --test`, which runs hundreds of
 * players through every path; a test that reads the lines puts its own `write` here.
 */
export const productLog = {
  write: process.env.NODE_TEST_CONTEXT
    ? (_line: Record<string, unknown>) => {}
    : (line: Record<string, unknown>) => console.info(line)
};

/** Logs what a player did. Never throws: a log line is never in the way of a request. */
export function product(line: ProductLine): void {
  try {
    productLog.write(productLine(line));
  } catch {
    // Nothing to do: the request goes on.
  }
}

/** Logs a failure by kind and outcome, with the step it was in (`op`) where there is one. */
export function failure<K extends keyof typeof FAILURES>(
  kind: K,
  outcome: (typeof FAILURES)[K][number],
  op?: ModeratorOp | Front
): void {
  try {
    console.error(op ? { event: kind, outcome, op } : { event: kind, outcome });
  } catch {
    // Nothing to do: the request goes on.
  }
}
