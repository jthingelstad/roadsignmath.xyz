// "Posted already?": the signs near a place that share most of a new sign's numbers. One lookup for
// the app's `GET /signs/similar` and the website's posting form (src/web/post.tsx).

import { LIMITS } from '../api/contract.ts';
import { miles } from '../domain/geo.ts';
import type { Sign } from '../domain/types.ts';

/** How many of `wanted` the sign shows, each sign number matching once. */
export function sharedNumbers(wanted: string[], sign: Sign): number {
  const left = new Map<string, number>();
  for (const n of sign.numbers) left.set(n.value, (left.get(n.value) ?? 0) + 1);
  let shared = 0;
  for (const n of wanted) {
    const count = left.get(n) ?? 0;
    if (count > 0) {
      left.set(n, count - 1);
      shared++;
    }
  }
  return shared;
}

/**
 * The signs within `LIMITS.similarMiles` of the place that show at least half of the wanted
 * numbers (normalized), nearest first.
 */
export function similarSigns(
  signs: Sign[],
  lat: number,
  lng: number,
  wanted: string[]
): { sign: Sign; miles: number }[] {
  return signs
    .filter((s) => s.place.lat !== undefined && s.place.lng !== undefined)
    .map((s) => ({ sign: s, miles: miles(lat, lng, s.place.lat!, s.place.lng!) }))
    .filter((n) => n.miles <= LIMITS.similarMiles && sharedNumbers(wanted, n.sign) * 2 >= wanted.length)
    .sort((a, b) => a.miles - b.miles);
}
