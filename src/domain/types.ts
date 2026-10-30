// The data model. No score, rank or points: a sign is a photo, its numbers, where it was, who
// found it, and the ways people have found to make it true.

/** A number read off the photo, as the poster checked it. */
export type SignNumber = {
  /** Normalized decimal text: "90", "1.5". */
  value: string;
  /** What it was read from on the sign: "90th St", "EXIT 7B". */
  text?: string;
  /** Why the value differs from the text: "Letters dropped", "Read as 7". */
  why?: string;
  /** Where on the photo, as fractions of its width and height: [x, y, w, h], origin top left. */
  box?: [number, number, number, number];
};

export type Place = {
  /** "I-35W northbound, Bloomington, Minnesota". */
  label: string;
  /** Two-letter US state, when known. */
  state?: string;
  /** Missing when nobody knows where it was (Gross Vehicle Weight). */
  lat?: number;
  lng?: number;
  /** True when the pin is only as good as a town or a state. */
  approximate: boolean;
};

export type Photo = {
  id: string;
  width: number;
  height: number;
  /** Alt text from someone who looked, or "Photo of the <title> sign". */
  alt: string;
};

export type FinderRole = 'found' | 'took_photo' | 'spotted';

/** Someone who found the sign: a player, or a plain name for someone who doesn't play. */
export type Finder = { playerId?: string; name: string; role: FinderRole };

/**
 * shown: on the map for everyone.
 * held: the moderator held it back when it was posted; only its poster sees it.
 * hidden: a report was upheld; only its poster sees it.
 */
export type Visibility = 'shown' | 'held' | 'hidden';

export type Sign = {
  id: string;
  slug: string;
  title: string;
  caption?: string;
  photos: Photo[];
  numbers: SignNumber[];
  place: Place;
  /** The day it was found, YYYY-MM-DD in the finder's own time. */
  foundOn: string;
  postedAt: string;
  postedBy: string;
  finders: Finder[];
  visibility: Visibility;
  /** The first way found, for cards. Missing on a sign posted unsolved. */
  firstWay?: { text: string; value: string };
  wayCount: number;
};

export type Way = {
  id: string;
  signId: string;
  playerId: string;
  /** Canonical text from the checker. */
  text: string;
  /** What both sides equal. */
  value: string;
  /** The numbers it used, in reading order. */
  numbers: string[];
  createdAt: string;
};

export type Player = {
  id: string;
  handle: string;
  name: string;
  /** One of the avatar colors in the design. */
  avatarColor: string;
  bio?: string;
  /** Private. Never in a public answer. Missing until the player claims the account. */
  email?: string;
  createdAt: string;
};

export const AVATAR_COLORS = ['#006348', '#004C80', '#F2B300', '#B01C33', '#18201C'] as const;
