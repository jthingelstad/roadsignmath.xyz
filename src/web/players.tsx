// /players: everyone with a sign or a badge on the map, newest player first, as the design's
// Players board draws it. A card per player with their face, how long they've played (or their
// bio), their signs and states, and their newest sign's math on its plate. Earned badges are on
// the player's own page; a count of them is never shown (AGENTS.md, Badges). No ranks: the
// order is when each player started, never how much they've done.

import type { Hono } from 'hono';
import { byNewest, isPublic, playerStats, type People, type Urls } from '../api/views.ts';
import { earnedBadges } from '../domain/badges.ts';
import { texOf } from '../domain/equation.ts';
import type { Player, Sign, Way } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import { Avatar, Page, Plate } from './layout.tsx';
import { waysFor } from './signs.tsx';

const PLAYERS_STYLE = `
.everyone { background: var(--ground); }
.everyone > .wrap { padding-top: 32px; padding-bottom: 56px; display: flex; flex-direction: column; gap: 28px; }
.everyone h1 { margin: 0; font-size: clamp(36px, 7vw, 50px); line-height: 1; }
.everyone .lead { margin: 8px 0 0; font-size: 18px; color: var(--ink2); }
.people { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 20px; }
.pc { display: flex; flex-direction: column; gap: 18px; height: 100%; padding: 22px; background: var(--card); border: 1px solid var(--line);
  border-radius: 18px; color: var(--ink); text-decoration: none; }
.pc:hover { border-color: var(--green-ink); color: var(--ink); }
.pc .who { display: flex; gap: 16px; align-items: center; min-width: 0; }
.pc h2 { margin: 0; font-size: 26px; line-height: 1.1; }
.pc .sub { display: block; margin-top: 4px; color: var(--ink2); }
.pc dl { margin: 0; display: flex; gap: 28px; }
.pc dl div { display: flex; flex-direction: column; }
.pc dd { margin: 0; order: -1; font-size: 22px; font-weight: 900; line-height: 1.1; }
.pc dt { font-size: 14px; color: var(--ink2); }
.pc .newest { display: flex; flex-direction: column; gap: 8px; }
.pc .label { font-size: 14px; color: var(--ink2); }
.pc .plate > span { font-size: 18px; }
.pc b { font-weight: 800; }
.join-in { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 24px; padding: 24px;
  background: var(--tint); border-radius: 16px; color: #18201C; }
.join-in h2 { margin: 0; font-size: 22px; }
.join-in p { margin: 4px 0 0; color: #3B4540; }
.join-in a { display: inline-flex; align-items: center; min-height: 48px; padding: 0 22px; border-radius: 10px; background: var(--green);
  color: #fff; font-weight: 800; text-decoration: none; }
.join-in a:hover { background: var(--green-dark); color: #fff; }
`;

type Row = {
  player: Player;
  stats: ReturnType<typeof playerStats>;
  /** The day they started: their first sign found or posted, or their first way written. */
  since: string;
  /** Their newest sign, the newest sign they found another way on, or the newest they posted. */
  newest?: { sign: Sign; label: string; way: { text: string; tex: string | null } | null };
};

/** Everyone with a name and a sign or a badge on the map: the same test as their own page. */
export function playerRows(everyone: People, shown: Sign[], ways: Map<string, Way[]>): Row[] {
  const allWays = [...ways.values()].flat();
  const tex = (text: string) => ({ text, tex: texOf(text) ?? null });
  return [...everyone.values()]
    .filter((p) => p.name)
    .flatMap((player): Row[] => {
      const stats = playerStats(player, shown);
      if (!stats.sign_count && !earnedBadges(player.id, shown, ways).length) return [];
      const theirWays = allWays
        .filter((w) => w.playerId === player.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // A sign they posted for other finders counts as playing (it earns First Sign), not as theirs.
      const posted = shown.filter((s) => s.postedBy === player.id).sort(byNewest);
      const since = [
        ...stats.signs.map((s) => s.foundOn),
        ...posted.map((s) => s.foundOn),
        ...theirWays.map((w) => w.createdAt.slice(0, 10))
      ].sort()[0];
      const top = stats.signs[0];
      const wayOn = theirWays.map((w) => ({ w, sign: shown.find((s) => s.id === w.signId) })).find((x) => x.sign);
      const post = posted[0];
      const newest = top
        ? { sign: top, label: 'Newest sign', way: top.firstWay ? tex(top.firstWay.text) : null }
        : wayOn?.sign
          ? { sign: wayOn.sign, label: 'Newest way', way: tex(wayOn.w.text) }
          : post && { sign: post, label: 'Newest post', way: post.firstWay ? tex(post.firstWay.text) : null };
      return [{ player, stats, since: since ?? '', ...(newest && { newest }) }];
    })
    .sort((a, b) => b.since.localeCompare(a.since) || a.player.name.localeCompare(b.player.name));
}

export function mountPlayers(
  site: Hono,
  { store, urls, people }: { store: Store; urls: Urls; people: () => Promise<People> }
): void {
  site.get('/players', async (c) => {
    const [signs, everyone] = await Promise.all([store.allSigns(), people()]);
    const shown = signs.filter(isPublic).sort(byNewest);
    const rows = playerRows(everyone, shown, await waysFor(store, shown));
    return c.html(
      <Page
        title="Players · Road Sign Math"
        description={`Everyone playing Road Sign Math: ${rows.length} ${rows.length === 1 ? 'player' : 'players'} and the road signs they've found.`}
        url={`${urls.site}/players`}
        here="players"
        style={PLAYERS_STYLE}
      >
        <main id="main" class="everyone">
          <div class="wrap">
            <div>
              <h1>Players</h1>
              <p class="lead">Everyone with a sign or a badge on the map, newest player first.</p>
            </div>
            {rows.length > 0 ? (
              <ul class="people">
                {rows.map(({ player, stats, since, newest }) => (
                  <li>
                    <a class="pc" href={`/players/${player.handle}`}>
                      <span class="who">
                        <Avatar name={player.name} color={player.avatarColor} photo={player.avatar} size={72} />
                        <span>
                          <h2>{player.name}</h2>
                          <span class="sub">{player.bio || (since && `Playing since ${since.slice(0, 4)}`)}</span>
                        </span>
                      </span>
                      {stats.sign_count > 0 && (
                        <dl>
                          <div>
                            <dt>{stats.sign_count === 1 ? 'sign' : 'signs'}</dt>
                            <dd>{stats.sign_count}</dd>
                          </div>
                          <div>
                            <dt>{stats.states.length === 1 ? 'state' : 'states'}</dt>
                            <dd>{stats.states.length}</dd>
                          </div>
                        </dl>
                      )}
                      {newest && (
                        <span class="newest">
                          <span class="label">{newest.label}</span>
                          {newest.way && <Plate way={newest.way} />}
                          <b>{newest.sign.title}</b>
                        </span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No one has posted a sign yet.</p>
            )}
            <div class="join-in">
              <div>
                <h2>Want to be on this page?</h2>
                <p>Post one sign from the app and you’re a player. There’s no score to keep.</p>
              </div>
              <a href="/app" data-tinylytics-event="app.get" data-tinylytics-event-value="players">
                Get the app →
              </a>
            </div>
          </div>
        </main>
      </Page>
    );
  });
}
