// Share cards: each page's og:image is its card on cards.thingelstad.com, which reads the page's
// microformats and draws the card from them (the sign's photo with its math over it, the player's
// face, Home's map with every pin). The card maker draws a card only at the v its page names, and
// v is a hash of exactly what the card shows, so a new way, a new photo or a new sign makes a new
// card. These builders are the one place that list lives; the page's microformats carry the same
// fields.

import { createHash } from 'node:crypto';

/** Where the cards are drawn: cards.thingelstad.com/rsm/<the page's path>.png. */
export const CARDS = 'https://cards.thingelstad.com/rsm';
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export type Card = { url: string; alt: string };

/** The first 10 hex of the SHA-256 of what the card shows, as a JSON array. */
export const cardVersion = (shows: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(shows)).digest('hex').slice(0, 10);

/** The card for the page at path ("/" is Home), showing `shows`. */
export const cardUrl = (path: string, shows: unknown[]): string =>
  `${CARDS}${path === '/' ? '/index' : path}.png?v=${cardVersion(shows)}`;

/** "a, b and c". */
const list = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export type SignShare = {
  path: string;
  title: string;
  photo: string | null;
  place: string;
  foundOn: string;
  finders: string[];
  /** The first way, as text and as LaTeX; null when nobody has solved it. */
  way: { text: string; tex: string | null } | null;
  wayCount: number;
  /** The sign's numbers; the card shows them when there is no way yet. */
  numbers: string[];
};

/** A sign's card: its photo with the first way's math over it, or its numbers when unsolved. */
export function signCard(s: SignShare): Card {
  const shows = [
    s.title,
    s.photo,
    s.place,
    s.foundOn,
    s.finders,
    s.way?.text ?? null,
    s.way?.tex ?? null,
    s.wayCount,
    s.way ? [] : s.numbers
  ];
  const by = `${s.finders.length ? ` Found by ${list(s.finders)}.` : ''}${s.place ? ` ${s.place}.` : ''}`;
  const alt = s.way
    ? `${s.title}: ${s.way.text}.${by}`
    : `${s.title}, not solved yet: the numbers ${list(s.numbers)}.${by}`;
  return { url: cardUrl(s.path, shows), alt };
}

export type PlayerShare = {
  path: string;
  name: string;
  photo: string | null;
  color: string;
  signCount: number;
  stateCount: number;
  firstYear: number | null;
};

/** A player's card: their profile photo, or their letter in their colour, with what they found. */
export function playerCard(p: PlayerShare): Card {
  const shows = [p.name, p.photo, p.photo ? null : p.color, p.signCount, p.stateCount, p.firstYear];
  const signs = `${p.signCount} ${p.signCount === 1 ? 'sign' : 'signs'}`;
  const states = p.stateCount ? ` in ${p.stateCount} ${p.stateCount === 1 ? 'state' : 'states'}` : '';
  const since = p.firstYear ? ` since ${p.firstYear}` : '';
  return { url: cardUrl(p.path, shows), alt: `${p.name} on Road Sign Math: ${signs} found${states}${since}.` };
}

export type HomeShare = {
  signCount: number;
  playerCount: number;
  stateCount: number;
  /** Each pin as [x, y, signs]: x and y in percent of the map's width and height. */
  pins: [number, number, number][];
};

/** Home's card: the map with every sign's pin, and how many signs, players and states. */
export function homeCard(h: HomeShare): Card {
  const shows = [h.signCount, h.playerCount, h.stateCount, h.pins.map(pinValue)];
  return {
    url: cardUrl('/', shows),
    alt: `Road Sign Math: a map of the United States with a pin for each of the ${h.signCount} signs players have found.`
  };
}

/** A pin's position as the page publishes it, two decimals of percent. */
export const pinValue = ([x, y, n]: [number, number, number]): string => `${x.toFixed(2)} ${y.toFixed(2)} ${n}`;
