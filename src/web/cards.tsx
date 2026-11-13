// The pieces every list of signs shares: the card (photo, title, the math drawn with MathJax, who
// and when), the heart, the separator dot, and the sort chips the app's sorts become on the web.

import type { FC } from 'hono/jsx';
import { heartPath, signPath, type signSummary } from '../api/views.ts';
import { shortDay } from './layout.tsx';
import { PHOTO_SIZES } from '../photos.ts';
import { mathSvg } from './math.ts';
import type { SortKey } from './sorts.ts';

export type Summary = ReturnType<typeof signSummary>;

export const finderNames = (s: Summary): string => s.finders.map((f) => f.name).join(', ');

/**
 * The dot between two facts ("Tyler · Sep 1"). Drawn, not typed: Overpass sets its middle dot
 * against the next word. Screen readers hear a comma.
 */
export const Sep: FC = () => (
  <span class="sep">
    <span class="vh">, </span>
  </span>
);

/** Facts joined by the dot, skipping the empty ones. */
export const Facts: FC<{ items: (string | false | null | undefined)[] }> = ({ items }) => (
  <>
    {items
      .filter((x): x is string => Boolean(x))
      .map((x, i) => (
        <>
          {i > 0 && <Sep />}
          {x}
        </>
      ))}
  </>
);

/**
 * Tinylytics' kudos button, filled in by its script with ❤️ and the count. The count is kept at
 * the sign's heart path (its address by slug, `heartPath`), the same one the app's hearts
 * use, so both add up together. It is not the page's address: never move it there. A card's
 * heart is filled when the card comes into view (`HEART_SCRIPT` in layout.tsx); `now` fills it
 * as soon as the script loads (the sign page's own).
 */
export const Heart: FC<{ sign: { slug: string; title: string }; now?: boolean }> = ({ sign, now }) => (
  <button
    type="button"
    class={now ? 'kudo tinylytics_kudos' : 'kudo'}
    data-path={heartPath(sign)}
    aria-label={`Heart the ${sign.title} sign`}
  />
);

type PhotoView = Summary['photos'][number];

/** How wide the thumb is: 480 px, or the photo's own width when it is smaller (photos.ts). */
export const thumbWidth = (p: Pick<PhotoView, 'width'>): number => Math.min(PHOTO_SIZES.thumb, p.width);

/**
 * Both sizes for the browser to choose from, at their real widths, or nothing when the photo is no
 * wider than the thumb (then the two are the same picture).
 */
export const photoSrcset = (p: PhotoView): string | undefined =>
  p.width > PHOTO_SIZES.thumb ? `${p.thumb_url} ${thumbWidth(p)}w, ${p.url} ${p.width}w` : undefined;

/** A small photo is never drawn wider than twice its real width: past that it only blurs. */
export const photoCap = (p: Pick<PhotoView, 'width'>): string => `max-width: min(100%, ${p.width * 2}px)`;

/** A sign's first way, drawn as the sign page draws it; the text when it has no LaTeX. */
export const Eq: FC<{ sign: Summary }> = ({ sign }) =>
  sign.first_way ? (
    sign.first_way.tex ? (
      <span
        class="eq mj"
        role="img"
        aria-label={sign.first_way.text}
        dangerouslySetInnerHTML={{ __html: mathSvg(sign.first_way.tex) }}
      />
    ) : (
      <span class="eq">{sign.first_way.text}</span>
    )
  ) : (
    <span class="soft">Not solved yet</span>
  );

/**
 * A square photo with the title, the math and who found it. `lat` and `lng` let the Nearby sort
 * order cards in the browser; `distance` is a label on the photo (the sign page's Nearby).
 */
export const Tile: FC<{ sign: Summary; distance?: string; place?: boolean; hidden?: boolean }> = ({
  sign,
  distance,
  place,
  hidden
}) => {
  const photo = sign.photos[0];
  return (
    <li
      class="tile"
      hidden={hidden}
      data-lat={sign.place.lat === null ? undefined : String(sign.place.lat)}
      data-lng={sign.place.lng === null ? undefined : String(sign.place.lng)}
    >
      <a href={signPath(sign)}>
        <span class="shot">
          {photo && <img src={photo.thumb_url} alt={photo.alt} loading="lazy" />}
          {distance && <span class="dist mono">{distance}</span>}
        </span>
        <span class="words">
          <strong>{sign.title}</strong>
          <Eq sign={sign} />
          <span class="soft">
            <Facts items={[finderNames(sign), shortDay(sign.found_on), place && sign.place.label]} />
            <span class="away" />
          </span>
        </span>
      </a>
      <div class="heart">
        <Heart sign={sign} />
      </div>
    </li>
  );
};

export const SORT_LABELS: Record<SortKey, string> = {
  latest: 'Latest',
  nearby: 'Nearby',
  popular: 'Popular',
  complexity: 'Complexity'
};

/** The four sorts as links, the current one marked. `href` makes each one's address. */
export const SortChips: FC<{ on: SortKey; href: (key: SortKey) => string; label?: string }> = ({
  on,
  href,
  label = 'Sort'
}) => (
  <div class="chips" role="group" aria-label={label}>
    {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
      <a class="chip" href={href(key)} aria-current={key === on ? 'true' : undefined} data-sort={key}>
        {SORT_LABELS[key]}
      </a>
    ))}
  </div>
);

/** What each sort means, in a line under the chips. */
export const SORT_NOTES: Record<SortKey, string> = {
  latest: 'Newest first.',
  nearby: 'Closest to you first. Your browser asks where you are, and that never leaves this page.',
  popular: 'Most hearts first, counting the app and this site.',
  complexity: 'The most complex math first. Roots, powers and factorials count for more than adding.'
};

export const CHIP_STYLE = `
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { position: relative; display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 999px;
  border: 1.5px solid var(--line2); background: var(--card); color: var(--ink); font-weight: 700; font-size: 15px; text-decoration: none; }
.chip[aria-current] { border-color: var(--chip-on); background: var(--chip-on); color: var(--chip-on-ink); font-weight: 800; }
.chip:hover { border-color: var(--ink); color: var(--ink); }
.chip[aria-current]:hover { color: var(--chip-on-ink); }
.locate { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 10px;
  border: 0; background: var(--yellow); color: #18201C; font: inherit; font-weight: 800; cursor: pointer; }
.sortnote { margin: 0; color: var(--soft); font-size: 15px; }
`;

/**
 * Nearby, in the browser: the page lists the signs newest first with their pins on each card;
 * "Use my location" asks the browser where it is and puts the closest first. The location never
 * leaves the page. `show` cards are visible at first and "Show more" (`.nearby-more`) shows `show`
 * more each time; without script every card is there.
 */
export const nearbyScript = (show: number): string => `
(() => {
  const list = document.querySelector('[data-nearby]');
  if (!list) return;
  const more = document.querySelector('.nearby-more');
  let shown = ${show};
  const fit = () => {
    [...list.children].forEach((li, i) => { li.hidden = i >= shown; });
    if (more) more.hidden = list.children.length <= shown;
    document.dispatchEvent(new Event('rsm:cards'));
  };
  fit();
  more?.addEventListener('click', () => {
    const next = list.children[shown];
    shown += ${show};
    fit();
    next?.querySelector('a')?.focus();
  });
  const button = document.querySelector('.locate');
  const note = document.querySelector('.sortnote');
  if (!button || !navigator.geolocation) return;
  button.hidden = false;
  const rad = (d) => (d * Math.PI) / 180;
  const miles = (a, b, c, d) => {
    const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  };
  const sort = (pos) => {
    const { latitude, longitude } = pos.coords;
    const cards = [...list.children].map((li) => {
      const pinned = li.dataset.lat !== undefined && li.dataset.lng !== undefined;
      const d = pinned ? miles(latitude, longitude, Number(li.dataset.lat), Number(li.dataset.lng)) : Infinity;
      return { li, d };
    });
    cards.sort((x, y) => x.d - y.d);
    cards.forEach(({ li, d }) => {
      const away = li.querySelector('.away');
      if (away) away.textContent = d === Infinity ? '' : ' (' + (d < 10 ? d.toFixed(1).replace(/\\.0$/, '') : Math.round(d)) + ' mi away)';
      list.append(li);
    });
    shown = ${show};
    fit();
    button.hidden = true;
    if (note) note.textContent = 'Closest to you first. Signs with no pin come last.';
  };
  const ask = () => {
    button.disabled = true;
    navigator.geolocation.getCurrentPosition(sort, () => {
      button.disabled = false;
      if (note) note.textContent = 'Your browser didn’t share a location, so these are newest first.';
    }, { maximumAge: 600000, timeout: 15000 });
  };
  button.addEventListener('click', ask);
  if (navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') ask(); }, () => {});
  }
})();`;
