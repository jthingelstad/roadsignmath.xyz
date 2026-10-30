// Checks shared by every route that takes words or counts tries.

import type { Store } from '../store/store.ts';
import { fail } from './errors.ts';

const CONTROL = /\p{Cc}/u;

/** Trimmed text with runs of white space made one space, `min` to `max` characters. */
export function text(raw: unknown, field: string, max: number, min: number): string {
  if (typeof raw !== 'string') return fail('bad_request', `${field} must be text`);
  const value = raw.trim().replace(/\s+/g, ' ');
  if (CONTROL.test(raw.replace(/[\n\t]/g, ' '))) fail('bad_request', `${field} can't hold control characters`);
  if (value.length < min || value.length > max) {
    fail('bad_request', min ? `${field} is ${min} to ${max} characters` : `${field} is at most ${max} characters`);
  }
  return value;
}

/** Counts one more try at `key` and fails with `message` once there are more than `max` in the window. */
export async function limit(store: Store, key: string, max: number, seconds: number, now: number, message: string) {
  if ((await store.bump(key, seconds, now)) > max) fail('rate_limited', message);
}
