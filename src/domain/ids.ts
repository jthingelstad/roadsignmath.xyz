import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: sorts by time, 26 characters. */
let last = { time: -1, rand: [] as number[] };

/**
 * A ULID for the millisecond `now`. Ids made in one process in the same millisecond (or with a
 * clock that went back) count up from the one before, so they sort in the order they were made.
 */
export function ulid(now = Date.now()): string {
  let rand: number[];
  if (now <= last.time) {
    now = last.time;
    rand = [...last.rand];
    let i = 15;
    while (i >= 0 && rand[i] === 31) rand[i--] = 0;
    if (i >= 0) rand[i] += 1;
  } else {
    rand = [...randomBytes(16)].map((b) => b % 32);
  }
  last = { time: now, rand };
  return ulidTime(now) + rand.map((r) => CROCKFORD[r]).join('');
}

/** The ten characters of a ULID that hold its millisecond. */
function ulidTime(ms: number): string {
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time;
}

export const isUlid = (s: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);

/** "I-35W at 82nd Street" → "i-35w-at-82nd-street". */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'sign';
}

/** The first of slug, slug-2, slug-3… that isn't taken. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** A ULID whose random half comes from `key`, so re-running a seed gives the same ids. */
export function ulidFrom(time: number, key: string): string {
  const digest = createHash('sha256').update(key).digest();
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[digest[i] % 32];
  return ulidTime(time) + rand;
}
