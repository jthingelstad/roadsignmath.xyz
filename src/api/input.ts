// Checks shared by every route that takes words or counts tries.

import type { Store } from '../store/store.ts';
import { fail } from './errors.ts';

const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
/** Embeddings, overrides and isolates: they turn the text around them and can make a name read as another. */
const turnsText = (cp: number): boolean => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BLACK_FLAG = 0x1f3f4;
const isTag = (cp: number): boolean => cp >= 0xe0020 && cp <= 0xe007f;

/**
 * Text without invisible format characters. Direction overrides and isolates are refused; other
 * invisible ones (zero-width space, direction marks, word joiner, byte order mark, soft hyphen)
 * are dropped, since a pasted name can carry them unseen. Kept: the joiners emoji and some
 * scripts need (U+200D, U+200C), and the tag characters of a subdivision flag after its black flag.
 */
function withoutFormat(raw: string, field: string): string {
  let out = '';
  let flag = false;
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (turnsText(cp)) fail('bad_request', `${field} can't hold characters that change the direction of text`);
    if (flag && isTag(cp)) {
      out += ch;
      continue;
    }
    flag = cp === BLACK_FLAG;
    if (cp === ZWJ || cp === ZWNJ || !FORMAT.test(ch)) out += ch;
  }
  return out;
}

/** Trimmed text with runs of white space made one space, `min` to `max` characters. */
export function text(raw: unknown, field: string, max: number, min: number): string {
  if (typeof raw !== 'string') return fail('bad_request', `${field} must be text`);
  if (CONTROL.test(raw.replace(/[\n\t]/g, ' '))) fail('bad_request', `${field} can't hold control characters`);
  const value = withoutFormat(raw, field).trim().replace(/\s+/g, ' ');
  if (value.length < min || value.length > max) {
    fail('bad_request', min ? `${field} is ${min} to ${max} characters` : `${field} is at most ${max} characters`);
  }
  return value;
}

/**
 * Counts one more try at `key` and fails with `message` once there are more than `max` in the
 * window. A refusal logs the limit's kind alone (`address`, `network`, `total`, `posts`...), never
 * the rest of the key, which names an address hash, a network or a player; the live stack counts
 * `total` refusals, when every sign-in email in the hour is used up (a metric, with no alarm).
 */
export async function limit(store: Store, key: string, max: number, seconds: number, now: number, message: string) {
  if ((await store.bump(key, seconds, now)) > max) {
    console.info({ event: 'limited', limit: key.split(':')[0] });
    fail('rate_limited', message);
  }
}

/**
 * A request's body, read only until it passes `max` bytes: what comes back is then longer than
 * `max`, for the caller to refuse, and the rest is never read. A body with no Content-Length
 * can't make the server hold more than that.
 */
export async function bodyUpTo(request: Request, max: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size > max) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}
