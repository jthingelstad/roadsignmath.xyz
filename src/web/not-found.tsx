// Every page that isn't there, as the design's NotFound board draws it: a Wrong Way sign, the
// address that was asked for, 404 = 4 × 101 on a plate, the way back to the map and to every
// sign, and the three newest signs. An address with a trailing slash goes to the one without it
// first, since no page here ends in one. The API's own 404s stay JSON (src/api/app.ts).

import type { Context } from 'hono';
import { byNewest, isPublic, signSummary, type People, type Urls } from '../api/views.ts';
import type { Store } from '../store/store.ts';
import { Facts, finderNames, type Summary } from './cards.tsx';
import { Page, Plate, shortDay } from './layout.tsx';

const LOST_STYLE = `
.lost { background: var(--ground); }
.lost > .wrap { padding-top: 56px; padding-bottom: 64px; display: flex; flex-direction: column; gap: 48px; }
.lost .road { display: flex; flex-wrap: wrap; align-items: center; gap: 32px 64px; }
.wrongway { flex: 0 0 auto; width: 300px; padding: 10px; border-radius: 12px; background: #B01C33;
  box-shadow: 0 14px 30px rgba(176, 28, 51, .25); }
.wrongway span { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 168px;
  border: 5px solid #fff; border-radius: 6px; color: #fff; font-size: 52px; font-weight: 900; line-height: 1; text-align: center; }
@media (max-width: 599px) { .wrongway { width: 200px; padding: 7px; } .wrongway span { min-height: 110px; border-width: 4px; font-size: 34px; } }
.lost .why { flex: 1 1 520px; display: flex; flex-direction: column; align-items: flex-start; gap: 18px; min-width: 0; }
.lost .why .kicker { margin: 0; color: var(--heart); font-size: 15px; letter-spacing: 0.18em; text-transform: uppercase; }
.lost h1 { margin: 0; font-size: clamp(34px, 5.5vw, 50px); line-height: 1.05; }
.lost .why p { margin: 0; max-width: 640px; font-size: 18px; color: var(--ink2); }
.lost code { padding: 1px 6px; border-radius: 6px; background: color-mix(in srgb, var(--green-ink) 12%, transparent);
  color: var(--ink); font-size: 16px; overflow-wrap: anywhere; }
.lost .plate > span { padding: 8px 24px; font-size: 28px; }
.lost .go { display: flex; flex-wrap: wrap; gap: 12px; }
.lost .go a { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 22px; border: 2px solid var(--green-ink);
  border-radius: 10px; background: var(--card); color: var(--green-ink); font-weight: 800; text-decoration: none; }
.lost .go a:first-child { border-color: var(--green); background: var(--green); color: #fff; }
.lost .go a:first-child:hover { border-color: var(--green-dark); background: var(--green-dark); }
.lost .go a:hover { color: var(--ink); }
.lost .go a:first-child:hover { color: #fff; }
.lost h2 { margin: 0 0 14px; font-size: 22px; }
.lost ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 12px; max-width: 1040px; }
.lost li a { display: flex; align-items: center; gap: 14px; height: 100%; padding: 12px; background: var(--card);
  border: 1px solid var(--line); border-radius: 12px; color: var(--ink); text-decoration: none; }
.lost li a:hover { border-color: var(--green-ink); }
.lost li img, .lost li .none { flex: 0 0 auto; width: 64px; height: 64px; border-radius: 8px; object-fit: cover; background: var(--photo); }
.lost li strong { display: block; font-size: 17px; line-height: 1.25; }
.lost li .soft { font-size: 14px; }
`;

/** The longest address the page repeats back; past that it ends in an ellipsis. */
const SHOW_PATH = 120;

/** The three newest shown signs, or none when the store can't be read: the page still answers. */
async function newest(store: Store, urls: Urls): Promise<Summary[]> {
  try {
    const [signs, players] = await Promise.all([store.allSigns(), store.allPlayers()]);
    const everyone: People = new Map(players.map((p) => [p.id, p]));
    return signs
      .filter(isPublic)
      .sort(byNewest)
      .slice(0, 3)
      .map((s) => signSummary(urls, everyone, s));
  } catch (err) {
    console.error(err);
    return [];
  }
}

/**
 * The answer for an address no route took. A GET for one ending in a slash goes to the same
 * address without it (and its query), unless that would leave the site (`//host`).
 */
export function notFoundPage({ store, urls }: { store: Store; urls: Urls }) {
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const trimmed = url.pathname.replace(/\/+$/, '');
    if (
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      trimmed &&
      trimmed !== url.pathname &&
      !trimmed.startsWith('//')
    ) {
      c.header('Cache-Control', 'public, max-age=3600');
      return c.redirect(trimmed + url.search, 301);
    }
    const signs = await newest(store, urls);
    const path = c.req.path.length > SHOW_PATH ? `${c.req.path.slice(0, SHOW_PATH)}…` : c.req.path;
    c.header('Cache-Control', 'no-store');
    return c.html(
      <Page
        title="Not found · Road Sign Math"
        description="There's no page at this address. Find your way back to the map, or see every sign."
        style={LOST_STYLE}
      >
        <main id="main" class="lost">
          <div class="wrap">
            <div class="road">
              <div class="wrongway" aria-hidden="true">
                <span>
                  WRONG
                  <br />
                  WAY
                </span>
              </div>
              <div class="why">
                <p class="kicker mono">Not found</p>
                <h1>This road doesn’t go anywhere.</h1>
                <p>
                  There’s no page at <code class="mono">{path}</code>. The sign may have a new name, or the address may
                  have a typo.
                </p>
                <Plate way={{ text: '404 = 4 × 101', tex: '404 = 4 \\times 101' }} />
                <div class="go">
                  <a href="/">
                    <span aria-hidden="true">←</span> Back to the map
                  </a>
                  <a href="/signs">See every sign</a>
                </div>
              </div>
            </div>
            {signs.length > 0 && (
              <section aria-labelledby="newest-h">
                <h2 id="newest-h">Or try one of the newest</h2>
                <ul>
                  {signs.map((s) => (
                    <li>
                      <a href={`/signs/${s.slug}`}>
                        {s.photos[0] ? (
                          <img src={s.photos[0].thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="none" />
                        )}
                        <span>
                          <strong>{s.title}</strong>
                          <span class="soft">
                            <Facts items={[finderNames(s), shortDay(s.found_on)]} />
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </main>
      </Page>,
      404
    );
  };
}
