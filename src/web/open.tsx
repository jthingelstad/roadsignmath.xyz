// The open-web routes: the feeds, the open data files, llms.txt and the /data page. Mounted on
// the site, so they are public and cached a minute like every page. The files and feeds are
// served with `Access-Control-Allow-Origin: *`, so any web page can fetch them.
//
// CloudFront compresses application/json and text/plain, but not application/atom+xml,
// application/feed+json or application/geo+json; those go out as they are. They are small at
// this size, and the right types matter more to the readers and map tools that use them.

import { Hono, type Context } from 'hono';
import type { Store } from '../store/store.ts';
import type { Urls } from '../api/views.ts';
import { loadOpenData, playersFile, signsFile, signsGeoJson } from './data.ts';
import { DocsPage } from './docs.tsx';
import { atomFeed, jsonFeed, playerFeed, siteFeed } from './feeds.ts';
import { llmsFullTxt, llmsTxt } from './llms.ts';

export const OPEN = { 'Access-Control-Allow-Origin': '*' };

const json = (c: Context, body: unknown, type: string) =>
  c.body(`${JSON.stringify(body, null, 2)}\n`, 200, { 'Content-Type': `${type}; charset=utf-8`, ...OPEN });

export function createOpenWeb({ store, urls }: { store: Store; urls: Urls }): Hono {
  const open = new Hono();
  const load = () => loadOpenData(store, urls);

  open.get('/signs.json', async (c) => json(c, signsFile(await load()), 'application/json'));
  open.get('/players.json', async (c) => json(c, playersFile(await load()), 'application/json'));
  open.get('/signs.geojson', async (c) => json(c, signsGeoJson(await load()), 'application/geo+json'));

  open.get('/feed.xml', async (c) => {
    const data = await load();
    return c.body(atomFeed(data, siteFeed(data)), 200, {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      ...OPEN
    });
  });
  open.get('/feed.json', async (c) => {
    const data = await load();
    return json(c, jsonFeed(data, siteFeed(data)), 'application/feed+json');
  });

  // A player's feeds: the signs they found. Only players whose page answers have them.
  const player = async (c: Context) => {
    const data = await load();
    const found = data.players.find((p) => p.handle === c.req.param('handle'));
    return found ? { data, feed: playerFeed(data, found) } : null;
  };
  open.get('/players/:handle/feed.xml', async (c) => {
    const got = await player(c);
    if (!got) return c.notFound();
    return c.body(atomFeed(got.data, got.feed), 200, {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      ...OPEN
    });
  });
  open.get('/players/:handle/feed.json', async (c) => {
    const got = await player(c);
    if (!got) return c.notFound();
    return json(c, jsonFeed(got.data, got.feed), 'application/feed+json');
  });

  open.get('/llms.txt', async (c) =>
    c.body(llmsTxt(await load()), 200, { 'Content-Type': 'text/plain; charset=utf-8', ...OPEN })
  );
  open.get('/llms-full.txt', async (c) =>
    c.body(llmsFullTxt(await load()), 200, { 'Content-Type': 'text/plain; charset=utf-8', ...OPEN })
  );

  open.get('/data', async (c) => c.html(<DocsPage data={await load()} />));

  return open;
}
