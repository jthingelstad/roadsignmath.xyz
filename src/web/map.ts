// Where signs go on the website's map: the us-atlas Albers USA frame (975 × 610, Alaska and
// Hawaii inset), and the pins gathered into clusters when they would sit on top of each other.
// The map is one picture, never zoomed, so a cluster is fixed by distance on that picture.

import { geoAlbersUsa } from 'd3-geo';
import { STATES } from '../domain/geo.ts';
import type { Sign } from '../domain/types.ts';
import { US_MAP_SIZE } from './us-map.ts';

// us-atlas draws states-albers-10m with exactly this projection.
const albers = geoAlbersUsa().scale(1300).translate([487.5, 305]);

/** A point on the map as percentages of its width and height, or null when it falls outside it. */
export function project(lat: number, lng: number): { x: number; y: number } | null {
  const point = albers([lng, lat]);
  if (!point) return null;
  return { x: (point[0] / US_MAP_SIZE.width) * 100, y: (point[1] / US_MAP_SIZE.height) * 100 };
}

export type Cluster = {
  /** The slug of its newest sign, which names it in a URL. */
  key: string;
  x: number;
  y: number;
  /** Newest first, as given. */
  signs: Sign[];
};

/** How close, in the map's own 975-wide units, two pins come before they share one. */
const GATHER = 26;

/**
 * Pins for signs, newest first, gathered greedily: each sign joins the first cluster whose
 * middle is within reach, or starts its own. Signs with no place, or one off the map, are left
 * out (`unpinned` lists them).
 */
export function cluster(signs: Sign[]): { clusters: Cluster[]; unpinned: Sign[] } {
  const clusters: (Cluster & { px: number; py: number; sx: number; sy: number })[] = [];
  const unpinned: Sign[] = [];
  for (const sign of signs) {
    const { lat, lng } = sign.place;
    const at = lat === undefined || lng === undefined ? null : project(lat, lng);
    if (!at) {
      unpinned.push(sign);
      continue;
    }
    const px = (at.x / 100) * US_MAP_SIZE.width;
    const py = (at.y / 100) * US_MAP_SIZE.height;
    const near = clusters.find((c) => Math.hypot(c.px - px, c.py - py) <= GATHER);
    if (near) {
      near.signs.push(sign);
      near.sx += px;
      near.sy += py;
      near.px = near.sx / near.signs.length;
      near.py = near.sy / near.signs.length;
    } else {
      clusters.push({ key: sign.slug, x: 0, y: 0, signs: [sign], px, py, sx: px, sy: py });
    }
  }
  return {
    clusters: clusters.map(({ key, signs: members, px, py }) => ({
      key,
      signs: members,
      x: (px / US_MAP_SIZE.width) * 100,
      y: (py / US_MAP_SIZE.height) * 100
    })),
    unpinned
  };
}

/** What a cluster is called: its one sign's place, or the states its signs are in. */
export function clusterName(c: Cluster): string {
  if (c.signs.length === 1) return c.signs[0].place.label;
  const states = [...new Set(c.signs.map((s) => s.place.state).filter((s): s is string => !!s))].map(
    (s) => STATES[s] ?? s
  );
  if (!states.length) return 'Here';
  return states.length === 1 ? states[0] : `${states.slice(0, -1).join(', ')} and ${states.at(-1)}`;
}

export const countSigns = (n: number): string => `${n} ${n === 1 ? 'sign' : 'signs'}`;
