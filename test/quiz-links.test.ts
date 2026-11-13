// Quiz linked from the site while it is open, and the site's words about players (Jamie,
// 2026-11-12): the header, Home, /app, /about and llms.txt name Quiz only while `quizOpen` is on
// and Quiz has an address; a first-era player who hasn't played since "Found signs" in those years.
// Fictional players and signs on the memory store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { ulidFrom } from '../src/domain/ids.ts';
import type { Player } from '../src/domain/types.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ScriptedModerator } from './support/moderator.ts';
import { ada, sign, way } from './support/fixtures.ts';

const SITE = 'https://example.test';
const QUIZ = 'https://quiz.example.test';

/** A fictional first-era player: their id carries the archive's time, as the seed makes them. */
const old: Player = {
  id: ulidFrom(Date.parse('2005-02-13T00:00:00Z'), 'archive-player:Olive Example'),
  handle: 'olive',
  name: 'Olive',
  avatarColor: '#004C80',
  createdAt: '2026-11-07T00:00:00.000Z'
};
const once: Player = {
  ...old,
  id: ulidFrom(Date.parse('2005-02-13T00:00:00Z'), 'archive-player:Otto Example'),
  handle: 'otto',
  name: 'Otto'
};

async function setup(open: { quizOpen?: boolean; quiz?: string }) {
  const store = new MemoryStore();
  for (const p of [ada, old, once]) await addPlayer(store, p);
  await store.putSign(sign({ id: '01JS0000000000000000000001', title: 'Newer Sign' }));
  await store.putWay(way('01JS0000000000000000000001'));
  const oldSign = (id: string, title: string, foundOn: string, player: Player) =>
    sign({
      id,
      title,
      foundOn,
      postedAt: `${foundOn}T12:00:00.000Z`,
      postedBy: player.id,
      finders: [{ playerId: player.id, name: player.name, role: 'found' }],
      firstWay: { text: '7 + 12 = 19', value: '19', playerId: player.id }
    });
  await store.putSign(oldSign('01JS0000000000000000000002', 'Old One', '2005-06-01', old));
  await store.putSign(oldSign('01JS0000000000000000000003', 'Old Two', '2006-07-01', old));
  await store.putSign(oldSign('01JS0000000000000000000004', 'Old Three', '2007-08-01', once));
  const app = createApp({
    store,
    urls: { site: SITE, ...(open.quiz && { quiz: open.quiz }) },
    mailer: new MemoryMailer(),
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    quizOpen: open.quizOpen
  });
  return { app, store, page: async (path: string) => (await app.request(path)).text() };
}

const NAV = /<nav aria-label="Main">(.*?)<\/nav>/s;

test('while Quiz is open, the header has Quiz after Players and before About, on every page', async () => {
  const { page } = await setup({ quizOpen: true, quiz: QUIZ });
  for (const path of [
    '/',
    '/signs',
    '/players',
    '/players/ada',
    '/signs/newer-sign',
    '/app',
    '/about',
    '/data',
    '/nowhere'
  ]) {
    const nav = NAV.exec(await page(path))![1];
    const links = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, ['/', '/signs', '/players', `${QUIZ}/`, '/about'], path);
    assert.match(
      nav,
      /<a href="https:\/\/quiz\.example\.test\/" data-tinylytics-event="quiz\.open" data-tinylytics-event-value="header">Quiz<\/a>/
    );
  }
  // The page you are on is still marked, and Quiz, another site, never is.
  assert.match(NAV.exec(await page('/players'))![1], /<a href="\/players" aria-current="page">Players<\/a>/);
  assert.ok(!/quiz\.example\.test\/"[^>]*aria-current/.test(await page('/about')));
});

test('while Quiz is open, Home, /app, /about and llms.txt name it, with their own events', async () => {
  const { page } = await setup({ quizOpen: true, quiz: QUIZ });
  const home = await page('/');
  assert.match(
    home,
    /No iPhone\? <a href="https:\/\/quiz\.example\.test\/" data-tinylytics-event="quiz\.open" data-tinylytics-event-value="home">Play Quiz<\/a> in any browser\./
  );
  const app = await page('/app');
  assert.match(
    app,
    /<dt>Android\?<\/dt><dd>[^<]*<\/dd><\/div><div><dt>No iPhone\?<\/dt><dd>Play <a href="https:\/\/quiz\.example\.test\/" data-tinylytics-event="quiz\.open" data-tinylytics-event-value="app">Quiz<\/a>/
  );
  assert.ok(app.includes('testflight.apple.com'), 'Try the beta stays on /app');
  assert.match(
    await page('/about'),
    /data-tinylytics-event="quiz\.open" data-tinylytics-event-value="about">Quiz<\/a> brings the signs/
  );
  assert.ok((await page('/llms.txt')).includes(`- [Quiz](${QUIZ}/): `));
  assert.ok((await page('/llms-full.txt')).includes(`Quiz (${QUIZ}/) is the game in any browser`));
  for (const html of [home, app]) assert.ok(!html.includes('quiz.try'), 'quiz.try stays the sign page’s');
});

test('with Quiz closed, or with no address for it, the site never names it', async () => {
  for (const open of [{ quizOpen: false, quiz: QUIZ }, { quizOpen: true }]) {
    const { page } = await setup(open);
    for (const path of ['/', '/players', '/app', '/about', '/llms.txt', '/llms-full.txt', '/nowhere']) {
      const html = await page(path);
      assert.ok(!html.includes('quiz.example.test') && !html.includes('quiz.open'), `${JSON.stringify(open)} ${path}`);
    }
    const nav = NAV.exec(await page('/'))![1];
    assert.deepEqual(
      [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]),
      ['/', '/signs', '/players', '/about']
    );
  }
});

test('Home says since 2005 and Players; first-era players found signs in their years, current ones play since', async () => {
  const { page } = await setup({});
  const home = await page('/');
  assert.ok(home.includes('Here are the signs players have found since 2005, all over the world.'));
  assert.ok(home.includes('<h2 id="who-h">Players</h2>'));
  assert.ok(!home.includes('Who’s playing'));
  const players = await page('/players');
  assert.match(players, /<h2>Olive<\/h2><span class="sub">Found signs 2005–2006<\/span>/);
  assert.match(players, /<h2>Otto<\/h2><span class="sub">Found signs 2007<\/span>/);
  assert.match(players, /<h2>Ada<\/h2><span class="sub">Counts everything\.<\/span>/);
  assert.ok((await page('/players/olive')).includes('<p class="since">Found signs 2005–2006</p>'));
  assert.ok((await page('/players/otto')).includes('<p class="since">Found signs 2007</p>'));
  // The data files keep their fields as they are.
  const file = JSON.parse(await page('/players.json'));
  assert.equal(file.players.find((p: { handle: string }) => p.handle === 'olive').first_year, 2005);
});

test('a first-era player who plays again is playing since their first year', async () => {
  const { store, page } = await setup({});
  await store.putWay(
    way('01JS0000000000000000000001', {
      id: 'way-olive',
      playerId: old.id,
      text: '19 − 12 = 7',
      value: '7',
      createdAt: '2026-11-10T12:00:00.000Z'
    })
  );
  assert.ok((await page('/players/olive')).includes('<p class="since">Playing since 2005</p>'));
  assert.match(await page('/players'), /<h2>Olive<\/h2><span class="sub">Playing since 2005<\/span>/);
  assert.ok((await page('/players/ada')).includes('<p class="since">Playing since 2026</p>'));
});
