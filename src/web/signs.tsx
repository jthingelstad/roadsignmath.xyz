// /signs: every shown sign, in the app's four sorts (Latest, Nearby, Popular, Complexity), with
// the year it was found and its state as filters. Every choice is a plain link or a GET form, so
// the page works without script and any view can be shared; Nearby's ordering is the one thing
// done in the browser (cards.tsx).

import type { Hono } from 'hono';
import { byNewest, isPublic, signSummary, type People, type Urls } from '../api/views.ts';
import { STATES } from '../domain/geo.ts';
import type { Sign, Way } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import { CHIP_STYLE, Facts, nearbyScript, SORT_NOTES, SortChips, Tile } from './cards.tsx';
import { Page } from './layout.tsx';
import { countSigns } from './map.ts';
import { sortOf, sortSigns, type SortKey } from './sorts.ts';

const SIGNS_STYLE = `
.every > .wrap { padding-top: 32px; padding-bottom: 56px; display: flex; flex-direction: column; gap: 32px; }
.every h1 { margin: 0; font-size: clamp(36px, 7vw, 50px); line-height: 1; }
.every .lead { margin: 8px 0 0; font-size: 18px; color: var(--ink2); }
.filters { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-start; padding: 18px 20px; background: var(--ground);
  border: 1px solid var(--line); border-radius: 16px; }
.filters .group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.filters .label { font-size: 14px; font-weight: 800; color: var(--ink2); }
.filters .sortline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.filters select { min-height: 44px; min-width: 200px; padding: 0 14px; border: 1.5px solid var(--line2); border-radius: 10px;
  background: var(--card); font: inherit; font-weight: 700; color: var(--ink); }
.filters button[type=submit] { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1.5px solid var(--line2);
  background: var(--card); font: inherit; font-weight: 800; color: var(--ink); cursor: pointer; }
.year { display: flex; flex-direction: column; gap: 20px; }
.year .yr { display: flex; align-items: baseline; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.year h2 { margin: 0; font-family: 'Overpass Mono', ui-monospace, monospace; font-size: 30px; font-weight: 700; }
.year .yr span { color: var(--soft); }
.none { margin: 0; font-size: 18px; }
${CHIP_STYLE}`;

/** The state menu sends its choice as soon as it changes; the button is there without script. */
const STATE_SCRIPT = `
document.querySelectorAll('form[data-auto]').forEach((form) => {
  const button = form.querySelector('button[type=submit]');
  if (button) button.hidden = true;
  form.querySelector('select')?.addEventListener('change', () => form.submit());
});`;

type Deps = {
  store: Store;
  urls: Urls;
  people: () => Promise<People>;
  counts: () => Promise<Map<string, number> | undefined>;
};

/** The ways on each listed sign, read only when Complexity needs them. */
export async function waysFor(store: Store, signs: Sign[]): Promise<Map<string, Way[]>> {
  const lists = await Promise.all(signs.map((s) => store.listWays(s.id)));
  return new Map(signs.map((s, i) => [s.id, lists[i]]));
}

export function mountSigns(site: Hono, { store, urls, people, counts }: Deps): void {
  site.get('/signs', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic).sort(byNewest);
    const sort = sortOf(c.req.query('sort'));
    const yearOf = (s: Sign) => s.foundOn.slice(0, 4);
    const years = [...new Set(shown.map(yearOf))].sort().reverse();
    const year = years.find((y) => y === c.req.query('year'));
    const states = [...new Set(shown.map((s) => s.place.state).filter((s): s is string => !!s))].sort((a, b) =>
      (STATES[a] ?? a).localeCompare(STATES[b] ?? b)
    );
    const state = states.find((s) => s === c.req.query('state')?.toUpperCase());
    const inYear = (s: Sign) => !year || yearOf(s) === year;
    const inState = (s: Sign) => !state || s.place.state === state;
    const picked = shown.filter((s) => inYear(s) && inState(s));
    const sorted = sortSigns(picked, sort, {
      counts: sort === 'popular' ? await counts() : undefined,
      ways: sort === 'complexity' ? await waysFor(store, picked) : undefined
    });
    const card = (s: Sign) => signSummary(urls, everyone, s);
    const players = new Set(shown.flatMap((s) => s.finders.map((f) => f.playerId).filter(Boolean)));

    // Every link keeps the other choices: a sort keeps the year and state, and so on.
    const href = (next: { sort?: SortKey; year?: string | null; state?: string | null }) => {
      const q = new URLSearchParams();
      const s = next.sort ?? sort;
      const y = next.year === undefined ? year : next.year;
      const st = next.state === undefined ? state : next.state;
      if (s !== 'latest') q.set('sort', s);
      if (y) q.set('year', y);
      if (st) q.set('state', st);
      const query = q.toString();
      return `/signs${query ? `?${query}` : ''}`;
    };
    const what = [state && STATES[state], year].filter(Boolean).join(', ');
    const title = what ? `Signs: ${what}` : 'Every sign';

    return c.html(
      <Page
        title={`${title} · Road Sign Math`}
        description={`Every Road Sign Math sign players have found: ${countSigns(shown.length)} so far, sorted the ways the app sorts them.`}
        url={`${urls.site}${href({})}`}
        here="signs"
        style={SIGNS_STYLE}
        script={STATE_SCRIPT + (sort === 'nearby' ? nearbyScript(sorted.length) : '')}
      >
        <main id="main" class="every">
          <div class="wrap">
            <div>
              <h1>{title}</h1>
              <p class="lead">
                <Facts
                  items={[
                    `${countSigns(shown.length)} from ${players.size} ${players.size === 1 ? 'player' : 'players'} in ${states.length} ${states.length === 1 ? 'state' : 'states'}`,
                    'Sorted the ways the app sorts them'
                  ]}
                />
              </p>
            </div>

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
                  <div class="chips" role="group" aria-label="Year found">
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

            {sorted.length === 0 ? (
              <p class="none">
                No signs match yet. <a href="/signs">See every sign</a>.
              </p>
            ) : sort === 'latest' ? (
              years
                .filter((y) => sorted.some((s) => yearOf(s) === y))
                .map((y) => {
                  const found = sorted.filter((s) => yearOf(s) === y);
                  return (
                    <section class="year" aria-labelledby={`y${y}`}>
                      <div class="yr">
                        <h2 id={`y${y}`}>{y}</h2>
                        <span>{countSigns(found.length)}</span>
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
                {sorted.map((s) => (
                  <Tile sign={card(s)} place />
                ))}
              </ul>
            )}
          </div>
        </main>
      </Page>
    );
  });
}
