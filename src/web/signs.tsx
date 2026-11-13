// /signs: every shown sign, in the app's four sorts (Latest, Nearby, Popular, Complexity), with
// the year it was found and its state as filters. Every choice is a plain link or a GET form, so
// the page works without script and any view can be shared; Nearby's ordering is the one thing
// done in the browser (cards.tsx).
//
// A page draws `PER_PAGE` cards. "Show more" is a link to the next page (`?page=2`, keeping the
// other choices), so readers without script and crawlers reach every sign; with script it fetches
// that page and adds its cards here instead. Nearby draws every card, since the browser reorders
// them, and shows them `PER_PAGE` at a time. The search box (search.ts) searches every sign from
// `/signs.json`, whatever page is drawn.
//
// A choice the page doesn't know (a sort, year or state with no signs, a page past the end) goes
// with a 301 to the page without it, and every filtered view names plain `/signs` as canonical.

import type { Context, Hono } from 'hono';
import { byNewest, isPublic, signSummary, type People, type Urls } from '../api/views.ts';
import { STATES } from '../domain/geo.ts';
import type { Sign, Way } from '../domain/types.ts';
import { PAGE_CACHE } from '../edge-cache.ts';
import type { Store } from '../store/store.ts';
import { CHIP_STYLE, Facts, nearbyScript, SORT_LABELS, SORT_NOTES, SortChips, Tile } from './cards.tsx';
import { Page } from './layout.tsx';
import { countSigns } from './map.ts';
import { SIGN_SEARCH_JS } from './search.ts';
import type { SiteCard } from './share.ts';
import { SORTS, sortOf, sortSigns, type SortKey } from './sorts.ts';

/** Cards on a page of /signs, and how many more "Show more" adds. */
export const PER_PAGE = 48;

const SIGNS_STYLE = `
.every > .wrap { padding-top: 32px; padding-bottom: 56px; display: flex; flex-direction: column; gap: 32px; }
.every h1 { margin: 0; font-size: clamp(36px, 7vw, 50px); line-height: 1; }
.every .lead { margin: 8px 0 0; font-size: 18px; color: var(--ink2); }
.every .pageno { margin: 8px 0 0; color: var(--soft); }
.filterbox { background: var(--ground); border: 1px solid var(--line); border-radius: 16px; }
.filterbox > summary { display: none; }
.filters { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-start; padding: 18px 20px; }
.filters .group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.filters .label { font-size: 14px; font-weight: 800; color: var(--ink2); }
.filters .sortline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.filters select { min-height: 44px; min-width: 200px; padding: 0 14px; border: 1.5px solid var(--line2); border-radius: 10px;
  background: var(--card); font: inherit; font-weight: 700; color: var(--ink); }
.filters button[type=submit] { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1.5px solid var(--line2);
  background: var(--card); font: inherit; font-weight: 800; color: var(--ink); cursor: pointer; }
.search { display: flex; flex-direction: column; gap: 8px; }
.search[hidden] { display: none; }
.search label { font-size: 14px; font-weight: 800; color: var(--ink2); }
.search input { width: 100%; max-width: 560px; min-height: 48px; padding: 0 16px; border: 1.5px solid var(--line2); border-radius: 12px;
  background: var(--card); font: inherit; font-size: 17px; color: var(--ink); }
.search .found { margin: 0; color: var(--soft); min-height: 1.5em; }
/* Empty, it stays in the page for screen readers but takes no room. */
.search .found:empty { min-height: 0; margin-top: -8px; }
.listing { display: flex; flex-direction: column; gap: 32px; }
.listing[hidden], .results[hidden] { display: none; }
.year { display: flex; flex-direction: column; gap: 20px; }
.year .yr { display: flex; align-items: baseline; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.year h2 { margin: 0; font-family: 'Overpass Mono', ui-monospace, monospace; font-size: 30px; font-weight: 700; }
.year .yr span { color: var(--soft); }
.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px 20px; padding-top: 8px; }
.pager .count { margin: 0; color: var(--soft); }
.more, .nearby-more { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 28px;
  border-radius: 999px; border: 1.5px solid var(--ink); background: var(--card); color: var(--ink); font: inherit;
  font-weight: 800; text-decoration: none; cursor: pointer; }
.more:hover, .nearby-more:hover { background: var(--ink); color: var(--card); }
.nearby-more { align-self: center; }
.nearby-more[hidden] { display: none; }
.none { margin: 0; font-size: 18px; }
${CHIP_STYLE}
@media (max-width: 699px) {
  .filterbox > summary { display: flex; align-items: center; gap: 12px; min-height: 52px;
    padding: 0 20px; cursor: pointer; font-weight: 800; list-style: none; }
  .filterbox > summary::-webkit-details-marker { display: none; }
  .filterbox > summary > span:first-child { flex: none; white-space: nowrap; }
  .filterbox > summary::after { content: ''; width: 9px; height: 9px; border: solid currentColor; border-width: 0 2px 2px 0;
    transform: rotate(45deg); margin: -4px 4px 0 auto; flex: none; }
  .filterbox[open] > summary::after { transform: rotate(-135deg); margin-top: 4px; }
  .filterbox > summary .now { min-width: 0; font-weight: 600; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filterbox[open] .filters { padding-top: 0; }
  .filters { flex-direction: column; align-items: stretch; }
  .filters .yearchips { flex-wrap: nowrap; overflow-x: auto; margin: 0 -20px; padding: 0 20px 4px; scrollbar-width: none; }
  .filters .yearchips::-webkit-scrollbar { display: none; }
  .filters .yearchips .chip { flex: none; }
}`;

/** The state menu sends its choice as soon as it changes; the button is there without script. */
const STATE_SCRIPT = `
document.querySelectorAll('form[data-auto]').forEach((form) => {
  const button = form.querySelector('button[type=submit]');
  if (button) button.hidden = true;
  form.querySelector('select')?.addEventListener('change', () => form.submit());
});`;

/**
 * On a phone the filters start folded, under a line that says what is chosen; wider, they are
 * always open. Without script they are open everywhere.
 */
const FOLD_SCRIPT = `
(() => {
  const box = document.querySelector('.filterbox');
  if (!box || !window.matchMedia) return;
  const narrow = window.matchMedia('(max-width: 699px)');
  // Nearby's button is inside the box, so it stays open while it is there to tap.
  const fit = () => { box.open = !narrow.matches || !!box.querySelector('.locate'); };
  fit();
  narrow.addEventListener?.('change', fit);
})();`;

/**
 * "Show more" with script: fetch the next page and add its cards to this one (into the same year
 * when Latest carries on through one), then point the link at the page after, or remove it at
 * the end. Any failure follows the link instead.
 */
const MORE_SCRIPT = `
(() => {
  const listing = document.querySelector('.listing[data-list]');
  if (!listing || !window.fetch || !window.DOMParser) return;
  listing.addEventListener('click', async (event) => {
    const more = event.target.closest('a.more');
    if (!more) return;
    event.preventDefault();
    if (more.getAttribute('aria-busy')) return;
    const focused = document.activeElement === more;
    more.setAttribute('aria-busy', 'true');
    more.textContent = 'Loading…';
    try {
      const res = await fetch(more.href);
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const next = doc.querySelector('.listing[data-list]');
      if (!next) throw new Error('no list');
      const added = [];
      const flat = listing.querySelector(':scope > ul.tiles');
      if (flat) {
        next.querySelectorAll(':scope > ul.tiles > li').forEach((li) => { added.push(li); flat.append(li); });
      } else {
        const pager = listing.querySelector('.pager');
        next.querySelectorAll(':scope > section.year').forEach((section) => {
          const id = section.getAttribute('aria-labelledby');
          const mine = listing.querySelector('section.year[aria-labelledby="' + id + '"] ul.tiles');
          const cards = [...section.querySelectorAll('ul.tiles > li')];
          added.push(...cards);
          if (mine) cards.forEach((li) => mine.append(li));
          else pager.before(section);
        });
      }
      const after = next.querySelector('a.more');
      const pager = listing.querySelector('.pager');
      const count = pager?.querySelector('.count');
      if (count && pager.dataset.total) {
        count.textContent = 'Showing ' + listing.querySelectorAll('li.tile').length + ' of ' + pager.dataset.total + ' signs';
      }
      if (after) {
        more.href = after.getAttribute('href');
        more.textContent = 'Show more';
        more.removeAttribute('aria-busy');
      } else {
        more.remove();
      }
      document.dispatchEvent(new Event('rsm:cards'));
      if (focused) added[0]?.querySelector('a')?.focus();
    } catch {
      location.href = more.href;
    }
  });
})();`;

/**
 * The search box: hidden without script. The first time someone types it fetches /signs.json, and
 * the plain pages of /signs for their cards (the math on them is drawn on the server), then filters
 * every sign on each keystroke (search.ts) and shows the matching cards in place of the page's own
 * list, which comes back when the box is emptied. A sign whose card it can't find gets one drawn
 * here, with its math as text.
 */
const SEARCH_SCRIPT = `${SIGN_SEARCH_JS}
(() => {
  const box = document.querySelector('.search');
  const results = document.querySelector('.results');
  const listing = document.querySelector('.listing[data-list]');
  if (!box || !results || !listing || !window.fetch || !window.DOMParser) return;
  const input = box.querySelector('input');
  const note = box.querySelector('.found');
  box.hidden = false;
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  const sep = () => {
    const dot = make('span', 'sep');
    dot.append(make('span', 'vh', ', '));
    return dot;
  };
  const drawn = new Map();
  const fresh = (li) => {
    // A copy of a card whose heart Tinylytics has filled: empty again, for HEART_SCRIPT to fill.
    const copy = li.cloneNode(true);
    copy.hidden = false;
    copy.querySelectorAll('.kudo').forEach((b) => {
      b.className = 'kudo';
      b.removeAttribute('data-tinylytics-kudos-bound');
      b.removeAttribute('data-watched');
      b.replaceChildren();
    });
    return copy;
  };
  const tile = (s) => {
    const card = drawn.get(s.slug);
    if (card) return fresh(card);
    const li = make('li', 'tile');
    const a = make('a');
    a.href = '/signs/' + s.slug;
    const shot = make('span', 'shot');
    const photo = s.photos[0];
    if (photo) {
      const img = make('img');
      img.src = photo.thumb_url;
      img.alt = photo.alt || '';
      img.loading = 'lazy';
      shot.append(img);
    }
    const words = make('span', 'words');
    words.append(make('strong', '', s.title));
    words.append(s.ways[0] ? make('span', 'eq', s.ways[0].text) : make('span', 'soft', 'Not solved yet'));
    const facts = make('span', 'soft');
    [s.finders.map((f) => f.name).join(', '), day.format(new Date(s.found_on + 'T00:00:00Z')), s.place.label]
      .filter(Boolean)
      .forEach((x, i) => { if (i) facts.append(sep()); facts.append(x); });
    words.append(facts);
    a.append(shot, words);
    const heart = make('div', 'heart');
    const button = make('button', 'kudo');
    button.type = 'button';
    button.dataset.path = '/signs/' + s.slug;
    button.setAttribute('aria-label', 'Heart the ' + s.title + ' sign');
    heart.append(button);
    li.append(a, heart);
    return li;
  };
  let signs;
  let loading;
  const get = (url, read) => fetch(url).then((r) => (r.ok ? r[read]() : Promise.reject(new Error(String(r.status)))));
  const pages = Number(box.dataset.pages) || 1;
  const cards = () => Promise.all(
    Array.from({ length: pages }, (_, i) => get('/signs' + (i ? '?page=' + (i + 1) : ''), 'text').then((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('.listing li.tile').forEach((li) => {
        const slug = li.querySelector('a')?.getAttribute('href')?.split('/').pop();
        if (slug) drawn.set(decodeURIComponent(slug), li);
      });
    }))
  ).catch(() => {});
  const load = () => (loading ??= Promise.all([get('/signs.json', 'json'), cards()])
    .then(([d]) => { signs = d.signs; }));
  const failed = () => { loading = undefined; };
  const show = () => {
    const query = input.value.trim();
    if (!query) {
      results.hidden = true;
      results.replaceChildren();
      listing.hidden = false;
      note.textContent = '';
      return;
    }
    if (!signs) {
      note.textContent = 'Searching…';
      load().then(show, () => { failed(); note.textContent = 'Search couldn’t load the signs. Try again in a moment.'; });
      return;
    }
    const found = signs.filter((s) => rsmSignMatches(s, query));
    results.replaceChildren(...found.map(tile));
    results.hidden = found.length === 0;
    listing.hidden = true;
    note.textContent = found.length === 0
      ? 'No signs match “' + query + '”.'
      : found.length === 1 ? '1 sign matches.' : found.length + ' signs match.';
    document.dispatchEvent(new Event('rsm:cards'));
  };
  let wait;
  input.addEventListener('input', () => { clearTimeout(wait); wait = setTimeout(show, 120); });
  input.addEventListener('focus', () => { load().catch(failed); }, { once: true });
  if (input.value) show();
})();`;

type Deps = {
  store: Store;
  urls: Urls;
  people: () => Promise<People>;
  counts: () => Promise<Map<string, number> | undefined>;
  siteCard: SiteCard;
  /** Quiz's address while it is open, for the header. */
  quiz?: string;
};

/** The ways on each listed sign, read only when Complexity needs them. */
export async function waysFor(store: Store, signs: Sign[]): Promise<Map<string, Way[]>> {
  const lists = await Promise.all(signs.map((s) => store.listWays(s.id)));
  return new Map(signs.map((s, i) => [s.id, lists[i]]));
}

/** Gone for good to `to`, cached like a page. */
const moved = (c: Context, to: string) => {
  c.header('Cache-Control', PAGE_CACHE);
  return c.redirect(to, 301);
};

export function mountSigns(site: Hono, { store, urls, people, counts, siteCard, quiz }: Deps): void {
  site.get('/signs', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic).sort(byNewest);
    // An empty value (the state menu's "All states") is the same as none.
    const asked = {
      sort: c.req.query('sort') || undefined,
      year: c.req.query('year') || undefined,
      state: c.req.query('state') || undefined,
      page: c.req.query('page') || undefined
    };
    const sort = sortOf(asked.sort);
    const yearOf = (s: Sign) => s.foundOn.slice(0, 4);
    const years = [...new Set(shown.map(yearOf))].sort().reverse();
    const year = years.find((y) => y === asked.year);
    const states = [...new Set(shown.map((s) => s.place.state).filter((s): s is string => !!s))].sort((a, b) =>
      (STATES[a] ?? a).localeCompare(STATES[b] ?? b)
    );
    const state = states.find((s) => s === asked.state?.toUpperCase());
    const inYear = (s: Sign) => !year || yearOf(s) === year;
    const inState = (s: Sign) => !state || s.place.state === state;

    // Every link keeps the other choices: a sort keeps the year and state, and so on. A new
    // choice starts again at the first page.
    const href = (next: { sort?: SortKey; year?: string | null; state?: string | null; page?: number }) => {
      const q = new URLSearchParams();
      const s = next.sort ?? sort;
      const y = next.year === undefined ? year : next.year;
      const st = next.state === undefined ? state : next.state;
      if (s !== 'latest') q.set('sort', s);
      if (y) q.set('year', y);
      if (st) q.set('state', st);
      if (next.page && next.page > 1) q.set('page', String(next.page));
      const query = q.toString();
      return `/signs${query ? `?${query}` : ''}`;
    };

    // A sort, year or state the page doesn't have goes to the page without it.
    const unknown =
      (asked.sort !== undefined && !(SORTS as readonly string[]).includes(asked.sort)) ||
      (asked.year !== undefined && !year) ||
      (asked.state !== undefined && !state);
    if (unknown) return moved(c, href({}));

    const picked = shown.filter((s) => inYear(s) && inState(s));
    const sorted = sortSigns(picked, sort, {
      counts: sort === 'popular' ? await counts() : undefined,
      ways: sort === 'complexity' ? await waysFor(store, picked) : undefined
    });

    // Pages: Nearby has none (the browser orders every card). The first page has no number.
    const paged = sort !== 'nearby';
    const pages = paged ? Math.max(1, Math.ceil(sorted.length / PER_PAGE)) : 1;
    const page = asked.page === undefined ? 1 : /^[1-9]\d{0,5}$/.test(asked.page) ? Number(asked.page) : 0;
    if (asked.page !== undefined && (page < 2 || page > pages)) return moved(c, href({}));
    const from = (page - 1) * PER_PAGE;
    const drawn = paged ? sorted.slice(from, from + PER_PAGE) : sorted;

    const card = (s: Sign) => signSummary(urls, everyone, s);
    const players = new Set(shown.flatMap((s) => s.finders.map((f) => f.playerId).filter(Boolean)));
    const filtered = sort !== 'latest' || !!year || !!state;
    const what = [state && STATES[state], year].filter(Boolean).join(', ');
    const title = what ? `Signs: ${what}` : 'Every sign';
    const chosen = [SORT_LABELS[sort], year ?? 'All years', state ? (STATES[state] ?? state) : 'All states'].join(', ');

    return c.html(
      <Page
        title={`${title}${page > 1 ? ` (page ${page})` : ''} · Road Sign Math`}
        description={`Every sign Road Sign Math players have found, ${shown.length} so far. Sort them the same ways the app does.`}
        url={`${urls.site}${href({ page })}`}
        canonical={filtered ? `${urls.site}/signs` : undefined}
        card={await siteCard({ signs, everyone })}
        here="signs"
        quiz={quiz}
        style={SIGNS_STYLE}
        script={
          STATE_SCRIPT + FOLD_SCRIPT + MORE_SCRIPT + SEARCH_SCRIPT + (sort === 'nearby' ? nearbyScript(PER_PAGE) : '')
        }
      >
        <main id="main" class="every">
          <div class="wrap">
            <div>
              <h1>{title}</h1>
              <p class="lead">
                <Facts
                  items={[
                    year || state
                      ? `${countSigns(picked.length)} of ${shown.length}`
                      : `${countSigns(shown.length)} from ${players.size} ${players.size === 1 ? 'player' : 'players'} in ${states.length} ${states.length === 1 ? 'state' : 'states'}`,
                    'Same sorts as the app'
                  ]}
                />
              </p>
              {page > 1 && (
                <p class="pageno">
                  Page {page} of {pages}. <a href={href({})}>Back to the first page</a>
                </p>
              )}
            </div>

            <div class="search" role="search" data-pages={String(Math.ceil(shown.length / PER_PAGE))} hidden>
              <label for="find">Search every sign</label>
              <input
                id="find"
                type="search"
                autocomplete="off"
                enterkeyhint="search"
                placeholder="A title, place, player or number"
              />
              <p class="found" aria-live="polite" />
            </div>

            <details class="filterbox" open>
              <summary>
                <span>Sort and filter</span>
                <span class="now">{chosen}</span>
              </summary>
              <div class="filters">
                <div class="group">
                  <span class="label">Sort</span>
                  <SortChips on={sort} href={(key) => href({ sort: key })} />
                  <div class="sortline">
                    <p class="sortnote">{SORT_NOTES[sort]}</p>
                    {sort === 'nearby' && (
                      <button type="button" class="locate" hidden>
                        Use my location
                      </button>
                    )}
                  </div>
                  {sort === 'nearby' && (
                    <noscript>
                      <p class="sortnote">Nearby needs JavaScript to ask your browser where you are.</p>
                    </noscript>
                  )}
                </div>
                {years.length > 1 && (
                  <div class="group">
                    <span class="label">Year found</span>
                    <div class="chips yearchips" role="group" aria-label="Year found">
                      <a class="chip" href={href({ year: null })} aria-current={year ? undefined : 'true'}>
                        <Facts items={['All', String(shown.filter(inState).length)]} />
                      </a>
                      {years.map((y) => {
                        // A year with nothing in the picked state is left out, unless it is the one picked.
                        const n = shown.filter((s) => inState(s) && yearOf(s) === y).length;
                        return (
                          (n > 0 || y === year) && (
                            <a class="chip" href={href({ year: y })} aria-current={y === year ? 'true' : undefined}>
                              <Facts items={[y, String(n)]} />
                            </a>
                          )
                        );
                      })}
                    </div>
                  </div>
                )}
                {states.length > 1 && (
                  <form class="group" action="/signs" method="get" data-auto="">
                    <label class="label" for="state">
                      State
                    </label>
                    {sort !== 'latest' && <input type="hidden" name="sort" value={sort} />}
                    {year && <input type="hidden" name="year" value={year} />}
                    <div style="display: flex; gap: 8px; flex-wrap: wrap">
                      <select id="state" name="state">
                        <option value="" selected={!state}>
                          All states
                        </option>
                        {states.map((st) => {
                          const n = shown.filter((s) => inYear(s) && s.place.state === st).length;
                          return (
                            (n > 0 || st === state) && (
                              <option value={st} selected={st === state}>
                                {STATES[st] ?? st} ({n})
                              </option>
                            )
                          );
                        })}
                      </select>
                      <button type="submit">Show</button>
                    </div>
                  </form>
                )}
              </div>
            </details>

            <ul class="tiles results" aria-label="Signs that match the search" hidden />

            <div class="listing" data-list="">
              {sorted.length === 0 ? (
                <p class="none">
                  No signs match yet. <a href="/signs">See every sign</a>.
                </p>
              ) : sort === 'latest' ? (
                years
                  .filter((y) => drawn.some((s) => yearOf(s) === y))
                  .map((y) => {
                    const found = drawn.filter((s) => yearOf(s) === y);
                    return (
                      <section class="year" aria-labelledby={`y${y}`}>
                        <div class="yr">
                          <h2 id={`y${y}`}>{y}</h2>
                          <span>{countSigns(sorted.filter((s) => yearOf(s) === y).length)}</span>
                        </div>
                        <ul class="tiles">
                          {found.map((s) => (
                            <Tile sign={card(s)} place />
                          ))}
                        </ul>
                      </section>
                    );
                  })
              ) : (
                <ul class="tiles" data-nearby={sort === 'nearby' ? '' : undefined}>
                  {drawn.map((s) => (
                    <Tile sign={card(s)} place />
                  ))}
                </ul>
              )}
              {sort === 'nearby' && sorted.length > PER_PAGE && (
                <button type="button" class="nearby-more" hidden>
                  Show more
                </button>
              )}
              {paged && pages > 1 && (
                <nav class="pager" aria-label="More signs" data-total={String(sorted.length)}>
                  <p class="count">
                    {page === 1
                      ? `Showing ${drawn.length} of ${sorted.length} signs`
                      : `Signs ${from + 1}–${from + drawn.length} of ${sorted.length}`}
                  </p>
                  {page < pages && (
                    <a class="more" href={href({ page: page + 1 })} rel="next">
                      Show more
                    </a>
                  )}
                </nav>
              )}
            </div>
          </div>
        </main>
      </Page>
    );
  });
}
