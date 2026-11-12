// What a reordered way changed against the way already on the sign, in words for the solve page:
// the sides of the = the other way round, numbers swapped or moved, or brackets that change
// nothing. Only for two ways `sameWayKey` already calls the same.

import { format, numbersIn, parse, sameWayKey, type Node } from '../domain/equation.ts';

/** "7", "7 and 12", "3, 4 and 5". */
const list = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const sideKey = (node: Node) => sameWayKey(format(node));

/** The numbers whose places differ between two sides, in the order the earlier way has them. */
function moved(tried: Node, was: Node): string[] {
  const a = numbersIn(tried);
  const b = numbersIn(was);
  const out: string[] = [];
  b.forEach((n, i) => {
    if (a[i] !== n && !out.includes(n)) out.push(n);
  });
  return out;
}

/**
 * A sentence saying what `tried` swapped against `was`, such as "You swapped 7 and 12." or "You
 * put the two sides of the = the other way round." Undefined when they aren't the same way, or
 * the difference can't be put in words.
 */
export function whatSwapped(tried: string, was: string): string | undefined {
  if (sameWayKey(tried) === undefined || sameWayKey(tried) !== sameWayKey(was)) return undefined;
  const t = parse(tried);
  const w = parse(was);
  if (!t || !w || t.length !== w.length) return undefined;
  const flipped = t.length === 2 && sideKey(t[0]) !== sideKey(w[0]) && sideKey(t[0]) === sideKey(w[1]);
  const pairs: [Node, Node][] = flipped
    ? [
        [t[1], w[0]],
        [t[0], w[1]]
      ]
    : t.map((side, i) => [side, w[i]]);
  const numbers = pairs.flatMap(([a, b]) => moved(a, b)).filter((n, i, all) => all.indexOf(n) === i);
  const parts: string[] = [];
  if (flipped) parts.push('put the two sides of the = the other way round');
  if (numbers.length === 2) parts.push(`swapped ${list(numbers)}`);
  else if (numbers.length > 2) parts.push(`moved ${list(numbers)} around`);
  if (parts.length) return `You ${parts.join(' and ')}.`;
  if (pairs.some(([a, b]) => format(a) !== format(b))) return 'The only difference is brackets that change nothing.';
  return undefined;
}
