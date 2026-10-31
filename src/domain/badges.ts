// Badges: little road signs a player collects for what happened on the road. No points: nothing
// is added up, ranked or compared. They are worked out from the signs on the map and the ways
// on them each time they are read, so a badge follows its sign; nothing about them is stored.
//
// A sign's badges (places, seasons, the numbers on it) go to whoever posted it and to every
// finder who plays. A way's badges (the math) go to whoever wrote it. Only shown signs count,
// and only the ways on them.

import { check, isFraction, numbersNotOnSign, type Node } from './equation.ts';
import { miles } from './geo.ts';
import type { Sign, Way } from './types.ts';

/** Each shelf is drawn as a family of road signs. */
export const SHELVES = ['firsts', 'places', 'math', 'seasons', 'secret'] as const;
export type Shelf = (typeof SHELVES)[number];

export type Badge = {
  id: string;
  shelf: Shelf;
  name: string;
  /** How it is earned, in a line. */
  how: string;
  /** What the sign shows: a word, a symbol or a number. Stepped badges show the step instead. */
  mark: string;
  /** For badges earned in steps, each step's count, smallest first. */
  steps?: number[];
  /** Hidden until earned: the catalog gives only its shelf and id. */
  secret?: boolean;
};

export const BADGES: Badge[] = [
  { id: 'first-sign', shelf: 'firsts', name: 'First Sign', how: 'Post your first sign.', mark: '1ST' },
  {
    id: 'lookout',
    shelf: 'firsts',
    name: 'Lookout',
    how: 'Be named as a finder on a sign someone else posted.',
    mark: 'LOOK'
  },
  {
    id: 'second-opinion',
    shelf: 'firsts',
    name: 'Second Opinion',
    how: 'Find a way on someone else’s sign.',
    mark: '2ND'
  },
  { id: 'cracked-it', shelf: 'firsts', name: 'Cracked It', how: 'Solve a sign that was posted unsolved.', mark: '?!' },
  {
    id: 'another-way',
    shelf: 'firsts',
    name: 'Another Way',
    how: 'Write a second, different way on the same sign.',
    mark: '+1'
  },
  {
    id: 'company',
    shelf: 'firsts',
    name: 'Company',
    how: 'Another player finds a way on a sign you posted.',
    mark: 'HI'
  },
  { id: 'states', shelf: 'places', name: 'States', how: 'Find signs in more states.', mark: '', steps: [2, 3, 5, 10] },
  {
    id: 'mile-markers',
    shelf: 'places',
    name: 'Mile Markers',
    how: 'Find more signs.',
    mark: '',
    steps: [3, 5, 10, 25]
  },
  { id: 'home-turf', shelf: 'places', name: 'Home Turf', how: 'Find 5 signs in one state.', mark: 'HOME' },
  {
    id: 'far-from-home',
    shelf: 'places',
    name: 'Far From Home',
    how: 'Find a sign at least 500 miles from your first.',
    mark: '500'
  },
  {
    id: 'road-trip',
    shelf: 'places',
    name: 'Road Trip',
    how: 'Find two signs within three days of each other.',
    mark: 'TRIP'
  },
  { id: 'times-table', shelf: 'math', name: 'Times Table', how: 'Use × in a way.', mark: '×' },
  { id: 'fair-share', shelf: 'math', name: 'Fair Share', how: 'Use ÷ in a way.', mark: '÷' },
  { id: 'square-root', shelf: 'math', name: 'Square Root', how: 'Use √ in a way.', mark: '√' },
  { id: 'power-up', shelf: 'math', name: 'Power Up', how: 'Use a power, like 2^3, in a way.', mark: 'xʸ' },
  {
    id: 'exclamation-point',
    shelf: 'math',
    name: 'Exclamation Point',
    how: 'Use a factorial, like 4!, in a way.',
    mark: '!'
  },
  {
    id: 'whole-keypad',
    shelf: 'math',
    name: 'Whole Keypad',
    how: 'Use every one of + − × ÷ √ ^ ! at least once, across your ways.',
    mark: '+−×÷'
  },
  {
    id: 'every-number',
    shelf: 'math',
    name: 'Every Number',
    how: 'Write a way that uses every number on a sign with at least three.',
    mark: '123'
  },
  {
    id: 'half-mile',
    shelf: 'math',
    name: 'Half Mile',
    how: 'Write a way that uses a decimal, or a division that comes to a fraction.',
    mark: '½'
  },
  { id: 'zero-sum', shelf: 'math', name: 'Zero Sum', how: 'Write a way where both sides come to 0.', mark: '0' },
  {
    id: 'big-number',
    shelf: 'math',
    name: 'Big Number',
    how: 'Write a way where both sides come to 1,000 or more.',
    mark: '1000'
  },
  {
    id: 'four-seasons',
    shelf: 'seasons',
    name: 'Four Seasons',
    how: 'Find signs in winter, spring, summer and fall, in any years.',
    mark: '4'
  },
  {
    id: 'still-playing',
    shelf: 'seasons',
    name: 'Still Playing',
    how: 'Find a sign a year or more after your first.',
    mark: '1 YR'
  },
  // Secret badges have plain ids, so the catalog gives nothing away.
  {
    id: 'secret-1',
    shelf: 'secret',
    name: 'The Answer',
    how: 'Write a way where both sides come to 42.',
    mark: '42',
    secret: true
  },
  { id: 'secret-2', shelf: 'secret', name: 'Route 66', how: 'Find a sign with a 66 on it.', mark: '66', secret: true },
  {
    id: 'secret-3',
    shelf: 'secret',
    name: 'Taxicab',
    how: 'Write a way where both sides come to 1729.',
    mark: '1729',
    secret: true
  },
  {
    id: 'secret-4',
    shelf: 'secret',
    name: 'Palindrome',
    how: 'Write a way that reads the same backwards, like 12 × 42 = 24 × 21.',
    mark: '⇄',
    secret: true
  },
  { id: 'secret-5', shelf: 'secret', name: 'Mile Zero', how: 'Find a sign with a 0 on it.', mark: '0', secret: true }
];

const BY_ID = new Map(BADGES.map((b) => [b.id, b]));
export const badge = (id: string): Badge => BY_ID.get(id)!;

/** An earned badge: the sign and day that earned it first, and for a stepped badge the step reached. */
export type Earned = {
  id: string;
  /** The step reached, for badges earned in steps. */
  step?: number;
  /** YYYY-MM-DD: the day the sign was found, or for math the day the way was written. */
  on: string;
  sign: Sign;
};

const FAR_MILES = 500;
const TRIP_DAYS = 3;
const DAY_MS = 86_400_000;

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** Winter, spring, summer or fall, by the month a sign was found. */
const season = (day: string): number => Math.floor((Number(day.slice(5, 7)) % 12) / 3);

/** Every operation a way uses: add, sub, mul, div, pow, sqrt, fact (a minus sign counts as sub). */
function operations(node: Node, out: Set<string>): Set<string> {
  if (node.op === 'neg') out.add('sub');
  else if (node.op !== 'num' && node.op !== 'group') out.add(node.op);
  if ('arg' in node) operations(node.arg, out);
  else if (node.op !== 'num') {
    operations(node.left, out);
    operations(node.right, out);
  }
  return out;
}

/** Whether a division somewhere in the math comes to a fraction, like 3 ÷ 6. */
function hasFraction(node: Node): boolean {
  if (node.op === 'div' && isFraction(node)) return true;
  if ('arg' in node) return hasFraction(node.arg);
  return node.op !== 'num' && (hasFraction(node.left) || hasFraction(node.right));
}

const KEYPAD = ['add', 'sub', 'mul', 'div', 'sqrt', 'pow', 'fact'];
const MIRROR: Record<string, string> = { '(': ')', ')': '(' };

/** Reads the same backwards, brackets mirrored, and does some math on the way. */
function isPalindrome(text: string): boolean {
  const bare = text.replace(/\s+/g, '');
  const back = [...bare]
    .reverse()
    .map((ch) => MIRROR[ch] ?? ch)
    .join('');
  return bare === back && /[+−×÷^√!]/.test(bare);
}

/** A way's exact value as a number, or undefined when the sides are only roughly equal. */
const exactValue = (way: Way): number | undefined => (way.value.startsWith('≈') ? undefined : Number(way.value));

/** The sign's first way was written with the post, so a sign without one was posted unsolved. */
const postedUnsolved = (sign: Sign, ways: Way[]): boolean => ways[0]?.createdAt !== sign.postedAt;

const byFound = (a: Sign, b: Sign): number =>
  a.foundOn.localeCompare(b.foundOn) || a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id);

const byWritten = (a: Way, b: Way): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The badges a player has earned from these signs and their ways, in catalog order. `signs` and
 * `ways` are what the reader may see (blocked players already left out); held and hidden signs
 * are dropped here.
 */
export function earnedBadges(playerId: string, signs: Sign[], ways: Map<string, Way[]>): Earned[] {
  const shown = signs.filter((s) => s.visibility === 'shown');
  const signById = new Map(shown.map((s) => [s.id, s]));
  const waysOn = (sign: Sign): Way[] => [...(ways.get(sign.id) ?? [])].sort(byWritten);
  const earned = new Map<string, Earned>();
  const earn = (id: string, sign: Sign, on: string, step?: number) => {
    if (!earned.has(id) || step !== undefined) earned.set(id, { id, sign, on, ...(step !== undefined && { step }) });
  };

  // The signs that count as theirs: posted by them or found with them, oldest found first.
  const theirs = shown
    .filter((s) => s.postedBy === playerId || s.finders.some((f) => f.playerId === playerId))
    .sort(byFound);
  // Their ways, oldest first, each with its sign.
  const mine = shown
    .flatMap((s) => waysOn(s).filter((w) => w.playerId === playerId))
    .sort(byWritten)
    .map((way) => ({ way, sign: signById.get(way.signId)!, on: way.createdAt.slice(0, 10) }));

  // Firsts
  const posted = theirs.find((s) => s.postedBy === playerId);
  if (posted) earn('first-sign', posted, posted.foundOn);
  const spotted = theirs.find((s) => s.postedBy !== playerId);
  if (spotted) earn('lookout', spotted, spotted.foundOn);
  for (const { way, sign, on } of mine) {
    if (sign.postedBy !== playerId) earn('second-opinion', sign, on);
    const onSign = waysOn(sign);
    if (onSign[0]?.id === way.id && postedUnsolved(sign, onSign)) earn('cracked-it', sign, on);
    if (onSign.filter((w) => w.playerId === playerId)[1]?.id === way.id) earn('another-way', sign, on);
  }
  const company = shown
    .filter((s) => s.postedBy === playerId)
    .flatMap((sign) =>
      waysOn(sign)
        .filter((w) => w.playerId !== playerId)
        .map((w) => ({ sign, way: w }))
    )
    .sort((a, b) => byWritten(a.way, b.way))[0];
  if (company) earn('company', company.sign, company.way.createdAt.slice(0, 10));

  // Places and seasons, walking their signs in the order they were found.
  const states = new Set<string>();
  const perState = new Map<string, number>();
  const seasons = new Set<number>();
  const firstPinned = theirs.find(
    (s) => s.place.lat !== undefined && s.place.lng !== undefined && !s.place.approximate
  );
  theirs.forEach((sign, i) => {
    const count = i + 1;
    const mileStep = badge('mile-markers')
      .steps!.filter((n) => n <= count)
      .pop();
    if (mileStep === count) earn('mile-markers', sign, sign.foundOn, mileStep);

    const state = sign.place.state;
    if (state && !states.has(state)) {
      states.add(state);
      if (badge('states').steps!.includes(states.size)) earn('states', sign, sign.foundOn, states.size);
    }
    if (state) {
      perState.set(state, (perState.get(state) ?? 0) + 1);
      if (perState.get(state) === 5) earn('home-turf', sign, sign.foundOn);
    }

    const { lat, lng, approximate } = sign.place;
    if (firstPinned && sign !== firstPinned && lat !== undefined && lng !== undefined && !approximate) {
      if (miles(firstPinned.place.lat!, firstPinned.place.lng!, lat, lng) >= FAR_MILES) {
        earn('far-from-home', sign, sign.foundOn);
      }
    }
    const before = theirs[i - 1];
    if (before && dayNumber(sign.foundOn) - dayNumber(before.foundOn) <= TRIP_DAYS) {
      earn('road-trip', sign, sign.foundOn);
    }

    seasons.add(season(sign.foundOn));
    if (seasons.size === 4) earn('four-seasons', sign, sign.foundOn);
    if (dayNumber(sign.foundOn) - dayNumber(theirs[0].foundOn) >= 365) earn('still-playing', sign, sign.foundOn);

    const values = sign.numbers.map((n) => n.value);
    if (values.includes('66')) earn('secret-2', sign, sign.foundOn);
    if (values.includes('0')) earn('secret-5', sign, sign.foundOn);
  });

  // The math, way by way.
  const used = new Set<string>();
  for (const { way, sign, on } of mine) {
    const result = check(way.text);
    const ops = result.ok ? result.sides.reduce((set, side) => operations(side, set), new Set<string>()) : new Set();
    if (ops.has('mul')) earn('times-table', sign, on);
    if (ops.has('div')) earn('fair-share', sign, on);
    if (ops.has('sqrt')) earn('square-root', sign, on);
    if (ops.has('pow')) earn('power-up', sign, on);
    if (ops.has('fact')) earn('exclamation-point', sign, on);
    for (const op of ops) used.add(op as string);
    if (KEYPAD.every((op) => used.has(op))) earn('whole-keypad', sign, on);

    const onSign = sign.numbers.map((n) => n.value);
    if (onSign.length >= 3 && numbersNotOnSign(onSign, way.numbers).length === 0) earn('every-number', sign, on);
    const sides = result.ok ? result.sides : [];
    if (way.numbers.some((n) => n.includes('.')) || sides.some(hasFraction)) earn('half-mile', sign, on);
    const value = exactValue(way);
    if (value === 0) earn('zero-sum', sign, on);
    if (value !== undefined && value >= 1000) earn('big-number', sign, on);
    if (value === 42) earn('secret-1', sign, on);
    if (value === 1729) earn('secret-3', sign, on);
    if (isPalindrome(way.text)) earn('secret-4', sign, on);
  }

  return BADGES.filter((b) => earned.has(b.id)).map((b) => earned.get(b.id)!);
}

/** What `after` has that `before` didn't: a new badge, or a higher step of one. */
export function newlyEarned(before: Earned[], after: Earned[]): Earned[] {
  const had = new Map(before.map((e) => [e.id, e.step ?? 0]));
  return after.filter((e) => !had.has(e.id) || (e.step ?? 0) > had.get(e.id)!);
}
