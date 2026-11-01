// Complexity: how much math a way does, for the Complexity sort. It is a property of the math,
// never a player's score, and no page shows the number: the order is the only signal.
//
// Each operator in a way counts once, weighted by how hard it is, and a way's complexity is the
// sum. Numbers, brackets and = count nothing. A sign's complexity is its most complex way, so a
// harder way found later moves the sign up; a sign nobody has solved is 0.
//
//   + −        1   adding and taking away
//   ×          2
//   ÷          3   a fraction
//   −x         2   a negative number
//   √  ^       4   roots and powers
//   !          5   a factorial
//
// So √(83 − √4) = 6 + 3 is 4 + 1 + 4 + 1 = 10, and 7 + 7 + (3 × 2) = 19 + 1 is 1 + 1 + 2 + 1 = 5.

import { parse, type Node } from './equation.ts';
import type { Sign, Way } from './types.ts';

export const COMPLEXITY_WEIGHTS = {
  add: 1,
  sub: 1,
  mul: 2,
  div: 3,
  neg: 2,
  sqrt: 4,
  pow: 4,
  fact: 5
} as const;

function score(node: Node): number {
  switch (node.op) {
    case 'num':
      return 0;
    case 'group':
      return score(node.arg);
    case 'neg':
    case 'sqrt':
    case 'fact':
      return COMPLEXITY_WEIGHTS[node.op] + score(node.arg);
    default:
      return COMPLEXITY_WEIGHTS[node.op] + score(node.left) + score(node.right);
  }
}

/** A way's complexity, from its text. Math that doesn't parse is 0. */
export function wayComplexity(text: string): number {
  const sides = parse(text);
  return sides ? sides.reduce((sum, side) => sum + score(side), 0) : 0;
}

/** A sign's complexity: its most complex way, or 0 when it has none. */
export function signComplexity(ways: Pick<Way, 'text'>[]): number {
  return ways.reduce((most, way) => Math.max(most, wayComplexity(way.text)), 0);
}

/**
 * Signs in the Complexity sort: the most complex first. The sort is stable, so signs that tie
 * keep the order they came in (newest first, everywhere they are listed), and signs nobody has
 * solved come last.
 */
export function byComplexity<S extends Pick<Sign, 'id'>>(signs: S[], ways: Map<string, Pick<Way, 'text'>[]>): S[] {
  const of = new Map(signs.map((s) => [s.id, signComplexity(ways.get(s.id) ?? [])]));
  return [...signs].sort((a, b) => of.get(b.id)! - of.get(a.id)!);
}
