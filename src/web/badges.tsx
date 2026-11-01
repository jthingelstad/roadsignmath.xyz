// Badges on the website, each drawn as a small road sign of its shelf's family: white plates for
// firsts, green guide signs and interstate shields for places, yellow diamonds for the math, brown
// signs for the seasons and blue service signs for the secret ones. Plain SVG, no script.

import type { FC } from 'hono/jsx';
import type { earnedBadgeView } from '../api/views.ts';
import { shortDay } from './layout.tsx';

export type BadgeView = ReturnType<typeof earnedBadgeView>;

const INK = '#1d1d1b';

/** The mark's size, so a word fits where a symbol would. */
const markSize = (mark: string): number => {
  const length = [...mark].length;
  return length <= 2 ? 24 : length === 3 ? 16 : length === 4 ? 13 : 11;
};

const Mark: FC<{ mark: string; color: string; y?: number; size?: number }> = ({ mark, color, y = 33, size }) => (
  <text
    x="32"
    y={y}
    fill={color}
    font-size={size ?? markSize(mark)}
    font-weight="800"
    font-family="Overpass, system-ui, -apple-system, sans-serif"
    text-anchor="middle"
    dominant-baseline="central"
  >
    {mark}
  </text>
);

/** A rectangular sign with the inset border real signs have. */
const Plate: FC<{ fill: string; edge: string; mark: string; ink: string; tall?: boolean }> = ({
  fill,
  edge,
  mark,
  ink,
  tall
}) => {
  const [x, y, w, h] = tall ? [18, 2, 28, 60] : [4, 12, 56, 40];
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx="6" fill={fill} />
      <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx="4" fill="none" stroke={edge} stroke-width="1.5" />
      {tall ? (
        <>
          <Mark mark="MILE" color={ink} y={18} size={8} />
          <Mark mark={mark} color={ink} y={38} size={mark.length > 1 ? 15 : 20} />
        </>
      ) : (
        <Mark mark={mark} color={ink} />
      )}
    </>
  );
};

const Art: FC<{ badge: BadgeView }> = ({ badge }) => {
  switch (badge.shelf) {
    case 'firsts':
      return (
        <>
          <rect x="10" y="4" width="44" height="56" rx="5" fill="#fff" stroke={INK} stroke-width="2.5" />
          <rect x="14" y="8" width="36" height="48" rx="3" fill="none" stroke={INK} stroke-width="1" />
          {/* An upright plate is narrow, so a long word gets smaller. */}
          <Mark mark={badge.mark} color={INK} size={[...badge.mark].length >= 4 ? 10 : undefined} />
        </>
      );
    case 'places':
      if (badge.id === 'states') {
        return (
          <>
            <path
              d="M6 12 Q32 2 58 12 L58 32 Q58 52 32 62 Q6 52 6 32 Z"
              fill="#0b4ea2"
              stroke="#fff"
              stroke-width="2"
            />
            <path d="M7 12.5 Q32 3 57 12.5 L57 22 L7 22 Z" fill="#c8102e" />
            <Mark mark={badge.mark} color="#fff" y={39} size={20} />
          </>
        );
      }
      if (badge.id === 'mile-markers') return <Plate fill="#00704a" edge="#fff" mark={badge.mark} ink="#fff" tall />;
      return <Plate fill="#00704a" edge="#fff" mark={badge.mark} ink="#fff" />;
    case 'math':
      return (
        <>
          <polygon points="32,2 62,32 32,62 2,32" fill="#ffc20e" stroke={INK} stroke-width="2.5" />
          <polygon points="32,7 57,32 32,57 7,32" fill="none" stroke={INK} stroke-width="1" />
          <Mark mark={badge.mark} color={INK} />
        </>
      );
    case 'seasons':
      return <Plate fill="#6b3e1e" edge="#fff" mark={badge.mark} ink="#fff" />;
    default:
      if (badge.id === 'secret-2') {
        return (
          <>
            <path
              d="M10 6 L54 6 Q56 16 60 20 Q56 44 32 60 Q8 44 4 20 Q8 16 10 6 Z"
              fill="#fff"
              stroke={INK}
              stroke-width="2.5"
            />
            <Mark mark={badge.mark} color={INK} y={34} size={22} />
          </>
        );
      }
      return <Plate fill="#00539b" edge="#fff" mark={badge.mark} ink="#fff" />;
  }
};

/** One earned badge: its sign, its name, how it is earned, and a link to the sign that earned it. */
const Earned: FC<{ badge: BadgeView }> = ({ badge }) => {
  const name = badge.step === null ? badge.name : `${badge.name}: ${badge.step}`;
  return (
    <li>
      <a href={`/signs/${badge.sign.slug}`}>
        <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
          <Art badge={badge} />
        </svg>
        <span class="what">
          <strong>{name}</strong>
          <span>{badge.how}</span>
          <span class="with">
            Earned {shortDay(badge.earned_on)} with {badge.sign.title}
          </span>
        </span>
      </a>
    </li>
  );
};

/** A player's earned badges as cards. Nothing about the ones not earned, and no count. */
export const BadgeCards: FC<{ badges: BadgeView[] }> = ({ badges }) => (
  <ul class="badges">
    {badges.map((b) => (
      <Earned badge={b} />
    ))}
  </ul>
);

export const BADGE_STYLE = `
.badges { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  gap: 12px; }
.badges a { display: flex; align-items: flex-start; gap: 14px; height: 100%; padding: 16px; background: var(--card);
  border: 1px solid var(--line); border-radius: 14px; color: var(--ink); text-decoration: none; }
.badges a:hover { border-color: var(--green-ink); color: var(--ink); }
.badges svg { flex: 0 0 auto; display: block; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .18)); }
.badges .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.badges strong { font-size: 17px; }
.badges .what span { font-size: 15px; color: var(--ink2); }
.badges .what .with { margin-top: 4px; font-size: 13px; color: var(--soft); }
`;
