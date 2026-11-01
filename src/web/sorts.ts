// The app's four sorts, on the website: Latest, Nearby, Popular and Complexity. Every list of
// signs comes in newest first; the sorts here are stable, so ties stay newest first. Nearby is
// sorted in the browser (cards.tsx), since only the browser knows where the reader is: here it
// keeps the newest-first order the page starts from.

import { byComplexity } from '../domain/complexity.ts';
import type { Sign, Way } from '../domain/types.ts';

export const SORTS = ['latest', 'nearby', 'popular', 'complexity'] as const;
export type SortKey = (typeof SORTS)[number];

/** The sort a request asked for, or Latest. */
export const sortOf = (raw: string | undefined): SortKey => SORTS.find((s) => s === raw) ?? 'latest';

/**
 * The signs in a sort. `counts` are hearts by path (`/signs/<slug>`), undefined when they can't
 * be read (Popular is then the newest); `ways` are every listed sign's ways, for Complexity.
 */
export function sortSigns(
  signs: Sign[],
  key: SortKey,
  { counts, ways }: { counts?: Map<string, number>; ways?: Map<string, Pick<Way, 'text'>[]> }
): Sign[] {
  if (key === 'popular') {
    const count = (s: Sign) => counts?.get(`/signs/${s.slug}`) ?? 0;
    return [...signs].sort((a, b) => count(b) - count(a));
  }
  if (key === 'complexity') return byComplexity(signs, ways ?? new Map());
  return signs;
}
