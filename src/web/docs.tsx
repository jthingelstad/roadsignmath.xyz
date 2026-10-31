// /data: the feeds, the open data files, the public API and llms.txt, for anyone who wants to
// follow the signs or build something with them. Every field of the files is listed here; the
// tests check the lists against the files, so a new field can't go undocumented.

import type { FC } from 'hono/jsx';
import { API_VERSION, ROUTES } from '../api/contract.ts';
import { DATA_VERSION, LICENSE, signRecord, type OpenData } from './data.ts';
import { FEED_SIZE } from './feeds.ts';
import { SOURCE_URL } from './llms.ts';
import { Page } from './layout.tsx';

/** A field: its path in the record (`place.lat`, `ways[].text`), its type, and what it is. */
export type Field = [name: string, type: string, what: string];

export const HEADER_FIELDS: Field[] = [
  [
    'version',
    'number',
    `The file’s format, now ${DATA_VERSION}. New fields can appear without it changing; it goes up if a field is renamed, removed or changes meaning.`
  ],
  ['title', 'string', 'The file’s name.'],
  ['description', 'string', 'What is in it.'],
  ['home_page_url', 'string', 'The site.'],
  ['url', 'string', 'The file itself.'],
  ['docs_url', 'string', 'This page.'],
  ['license.name', 'string', 'The licence for everything in the file, photos too: CC BY 4.0.'],
  ['license.url', 'string', 'The licence’s text.'],
  ['license.credit', 'string', 'How to give credit.'],
  ['updated', 'string or null', 'The newest change to any sign: a post or a way, as a UTC time.'],
  ['counts.signs', 'number', 'Shown signs.'],
  ['counts.players', 'number', 'Players with a page: a name, and a sign or a badge on the map.'],
  ['counts.states', 'number', 'US states with a sign.'],
  ['counts.ways', 'number', 'Ways to make the signs true, on all of them.']
];

export const SIGN_FIELDS: Field[] = [
  ['id', 'string', 'The sign’s id. Never changes.'],
  ['slug', 'string', 'Its name in its address, /signs/<slug>. Never changes.'],
  ['url', 'string', 'Its page.'],
  ['title', 'string', 'Its title, as the poster wrote it.'],
  ['caption', 'string or null', 'What the poster wrote about it.'],
  ['found_on', 'string', 'The day it was found, YYYY-MM-DD, in the finder’s own time. A day, not a moment.'],
  ['posted_at', 'string', 'When it was posted, as a UTC time.'],
  ['updated_at', 'string', 'When it last changed: when it was posted, or its newest way.'],
  ['posted_by', 'string or null', 'The handle of the player who posted it.'],
  ['place.label', 'string', 'Where it was, in words: “I-35W northbound, Bloomington, Minnesota”.'],
  ['place.state', 'string or null', 'The two-letter US state, when known.'],
  ['place.lat', 'number or null', 'Latitude. Null when nobody knows where it was.'],
  ['place.lng', 'number or null', 'Longitude. Null when nobody knows where it was.'],
  ['place.approximate', 'boolean', 'True when the point is only as good as a town or a state. Most are.'],
  ['numbers[].value', 'string', 'A number on the sign as a plain decimal: “90”, “1.5”.'],
  ['numbers[].text', 'string or null', 'What it was read from: “90th St”, “EXIT 7B”.'],
  ['numbers[].why', 'string or null', 'Why the value differs from the text: “Letters dropped”.'],
  [
    'numbers[].box',
    'array or null',
    'Where it is on the first photo, [x, y, width, height] as fractions of the photo, from the top left.'
  ],
  ['finders[].name', 'string', 'Who found it.'],
  ['finders[].handle', 'string or null', 'Their handle, when they play. Null for someone named who doesn’t.'],
  ['finders[].url', 'string or null', 'Their page, when they have one.'],
  ['finders[].role', 'string', 'found, took_photo or spotted.'],
  ['way_count', 'number', 'How many ways there are.'],
  ['ways[].text', 'string', 'The math as plain text, as the app’s checker writes it: “√(5 − 1) = 2”.'],
  ['ways[].tex', 'string or null', 'The same math as LaTeX, as the site draws it (÷ is a stacked fraction).'],
  ['ways[].value', 'string', 'What both sides come to.'],
  ['ways[].numbers', 'array of strings', 'The sign’s numbers the way used, in reading order.'],
  ['ways[].by', 'object or null', 'Who found the way: handle, name and url (their page, or null).'],
  [
    'ways[].created_at',
    'string',
    'When it was added, as a UTC time. Ways are oldest first; the first is the one on the sign’s plate.'
  ],
  ['photos[].id', 'string', 'The photo’s id. Never changes.'],
  ['photos[].width', 'number', 'Its width in pixels, at the large size.'],
  ['photos[].height', 'number', 'Its height in pixels, at the large size.'],
  ['photos[].alt', 'string', 'What the photo shows, in words.'],
  ['photos[].url', 'string', 'The photo, 1600 pixels on the long side, as a JPEG with no camera details or location.'],
  ['photos[].thumb_url', 'string', 'The same photo 480 pixels on the long side.']
];

export const PLAYER_FIELDS: Field[] = [
  ['handle', 'string', 'Their handle. Never changes.'],
  ['name', 'string', 'Their name.'],
  ['url', 'string', 'Their page.'],
  ['feed_url', 'string', 'Their JSON Feed; feed.xml beside it is Atom.'],
  ['bio', 'string or null', 'What they wrote about themselves.'],
  ['avatar_color', 'string', 'The colour behind their first letter when they have no photo.'],
  ['avatar_url', 'string or null', 'Their profile photo, 512 pixels square.'],
  ['avatar_thumb_url', 'string or null', 'The same, 160 pixels square.'],
  ['sign_count', 'number', 'Signs they are a finder on.'],
  ['way_count', 'number', 'Ways they found, on anyone’s signs.'],
  ['states', 'array of strings', 'The states of their signs, as two-letter codes.'],
  ['first_year', 'number or null', 'The year of their first sign.'],
  ['signs', 'array of strings', 'The slugs of their signs, newest first.'],
  [
    'badges[].id',
    'string',
    'A badge they earned. There are no points; badges are little road signs for what happened on the road.'
  ],
  ['badges[].shelf', 'string', 'firsts, places, math, seasons or secret.'],
  ['badges[].name', 'string', 'Its name.'],
  ['badges[].how', 'string', 'How it is earned.'],
  ['badges[].mark', 'string', 'What its little sign shows; for a stepped badge, the step reached.'],
  ['badges[].earned_on', 'string', 'The day it was earned, YYYY-MM-DD.'],
  ['badges[].sign', 'string', 'The slug of the sign that earned it.']
];

export const GEO_FIELDS: Field[] = [
  ['id', 'string', 'The sign’s id.'],
  ['geometry.coordinates', 'array', '[longitude, latitude], in that order, as GeoJSON has it.'],
  ['properties.slug', 'string', 'Its name in its address.'],
  ['properties.title', 'string', 'Its title.'],
  ['properties.url', 'string', 'Its page.'],
  ['properties.found_on', 'string', 'The day it was found, YYYY-MM-DD.'],
  ['properties.place', 'string', 'Where it was, in words.'],
  ['properties.state', 'string or null', 'The two-letter US state.'],
  ['properties.approximate', 'boolean', 'True when the point is the town, not the exact spot.'],
  ['properties.math', 'string or null', 'The first way, as plain text. Null when nobody has solved it.'],
  ['properties.way_count', 'number', 'How many ways there are.'],
  ['properties.finders', 'string', 'Who found it, names separated by commas.'],
  ['properties.photo_url', 'string or null', 'The first photo, large.'],
  ['properties.thumb_url', 'string or null', 'The first photo, small.']
];

const DOCS_STYLE = `
.docs { padding-top: 32px; padding-bottom: 56px; max-width: 900px; }
.docs h1 { margin: 0 0 8px; font-size: clamp(32px, 6vw, 44px); line-height: 1.05; }
.docs .lede { font-size: 19px; color: var(--ink2); margin: 0 0 24px; max-width: 680px; }
.docs h2 { margin: 48px 0 8px; font-size: 26px; scroll-margin-top: 16px; }
.docs h3 { margin: 28px 0 6px; font-size: 18px; }
.docs p, .docs li { max-width: 720px; }
.docs code { font-family: 'Overpass Mono', ui-monospace, monospace; font-size: .92em; overflow-wrap: anywhere; }
.files { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.files a { display: flex; flex-direction: column; gap: 4px; height: 100%; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--card); color: var(--ink); text-decoration: none; }
.files a:hover { border-color: var(--green); }
.files b { font-size: 17px; }
.files code { color: var(--green-ink); font-weight: 700; }
.files span { font-size: 14px; color: var(--soft); }
.fields { width: 100%; border-collapse: collapse; margin: 8px 0 0; font-size: 15px; }
.fields th { text-align: left; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--soft); padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line2); }
.fields td { vertical-align: top; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--rule); }
.fields td:first-child { width: 36%; }
.fields td:first-child code { display: block; font-weight: 700; color: var(--ink); }
.fields td:first-child small { color: var(--soft); font-size: 13px; }
pre { margin: 12px 0 0; padding: 14px 16px; border-radius: 12px; background: var(--ground); border: 1px solid var(--line);
  overflow-x: auto; font: 13px/1.5 'Overpass Mono', ui-monospace, monospace; }
.routes { margin: 8px 0 0; padding: 0; list-style: none; }
.routes li { padding: 8px 0; border-bottom: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 2px 12px; }
.routes code { font-weight: 700; }
.routes span { color: var(--ink2); }
`;

const Fields: FC<{ fields: Field[]; label: string }> = ({ fields, label }) => (
  <table class="fields" aria-label={label}>
    <thead>
      <tr>
        <th scope="col">Field</th>
        <th scope="col">What it is</th>
      </tr>
    </thead>
    <tbody>
      {fields.map(([name, type, what]) => (
        <tr>
          <td>
            <code>{name}</code>
            <small>{type}</small>
          </td>
          <td>{what}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** The newest sign as /signs.json has it, cut to two numbers, one way and one photo to stay short. */
function example(data: OpenData): string | null {
  const newest = data.signs[0];
  if (!newest) return null;
  const record = signRecord(data, newest);
  return JSON.stringify(
    {
      ...record,
      numbers: record.numbers.slice(0, 2),
      ways: record.ways.slice(0, 1),
      photos: record.photos.slice(0, 1)
    },
    null,
    2
  );
}

export const DocsPage: FC<{ data: OpenData }> = ({ data }) => {
  const site = data.urls.site;
  const sample = example(data);
  const reads = ROUTES.filter((r) => r.method === 'get' && r.auth === 'public');
  const mashup = `const res = await fetch('${site}/signs.json');
const { signs } = await res.json();
for (const sign of signs) {
  console.log(sign.title, sign.ways[0]?.text ?? 'not solved yet');
}`;
  return (
    <Page
      title="Feeds and data · Road Sign Math"
      description="Follow new signs in a feed reader, or build something with every sign: open JSON, GeoJSON, feeds, the API and llms.txt."
      url={`${site}/data`}
      style={DOCS_STYLE}
    >
      <main class="wrap docs">
        <h1>Feeds and data</h1>
        <p class="lede">
          Every sign on Road Sign Math is open to read. Follow new signs in a feed reader, or build something with them:
          a map, a quiz, a bot, a mashup. No key, no sign-up.
        </p>
        <ul class="files">
          <li>
            <a href="#feeds">
              <b>Feeds</b>
              <code>/feed.xml</code>
              <span>New signs, Atom and JSON Feed</span>
            </a>
          </li>
          <li>
            <a href="#signs">
              <b>Every sign</b>
              <code>/signs.json</code>
              <span>Numbers, ways, places, finders, photos</span>
            </a>
          </li>
          <li>
            <a href="#players">
              <b>Players</b>
              <code>/players.json</code>
              <span>Counts, states, signs and badges</span>
            </a>
          </li>
          <li>
            <a href="#geojson">
              <b>On a map</b>
              <code>/signs.geojson</code>
              <span>A point for every sign</span>
            </a>
          </li>
          <li>
            <a href="#api">
              <b>The API</b>
              <code>/api/v1</code>
              <span>Public JSON reads, OpenAPI</span>
            </a>
          </li>
          <li>
            <a href="#agents">
              <b>For agents</b>
              <code>/llms.txt</code>
              <span>The site in words, for AI tools</span>
            </a>
          </li>
        </ul>

        <h2 id="feeds">Feeds</h2>
        <p>
          The newest {FEED_SIZE} signs, each with its photos, the math, who found it, when and where, and any other ways
          to make it true. Paste the address into any feed reader.
        </p>
        <ul>
          <li>
            Atom: <a href="/feed.xml">{site}/feed.xml</a>
          </li>
          <li>
            JSON Feed 1.1: <a href="/feed.json">{site}/feed.json</a>
          </li>
          <li>
            One player’s signs: <code>/players/&lt;handle&gt;/feed.xml</code> and <code>feed.json</code>, linked from
            each player’s page.
          </li>
        </ul>
        <p>
          A sign’s item is dated when it was posted and updated when someone adds a way. Readers find the feeds on their
          own from any page here.
        </p>

        <h2 id="signs">Every sign</h2>
        <p>
          <a href="/signs.json">{site}/signs.json</a> has every sign on the map, newest posted first, with everything
          its page shows. It opens from any web page: it is served with <code>Access-Control-Allow-Origin: *</code>.
        </p>
        <pre>
          <code>{mashup}</code>
        </pre>
        <h3>The file</h3>
        <p>
          Each of the three files starts with the same fields, then its list: <code>signs</code>, <code>players</code>{' '}
          or <code>features</code>.
        </p>
        <Fields fields={HEADER_FIELDS} label="Fields at the top of each file" />
        <h3>A sign</h3>
        <Fields fields={SIGN_FIELDS} label="Fields of a sign in signs.json" />
        {sample && (
          <>
            <h3>An example</h3>
            <p>The newest sign, cut to two of its numbers, its first way and one photo:</p>
            <pre>
              <code>{sample}</code>
            </pre>
          </>
        )}

        <h2 id="players">Players</h2>
        <p>
          <a href="/players.json">{site}/players.json</a> has everyone with a sign or a badge on the map, most signs
          first: what their page shows, and never an email address.
        </p>
        <Fields fields={PLAYER_FIELDS} label="Fields of a player in players.json" />

        <h2 id="geojson">On a map</h2>
        <p>
          <a href="/signs.geojson">{site}/signs.geojson</a> is a GeoJSON FeatureCollection with a point for every sign
          that has a place, ready for Leaflet, MapLibre, QGIS or geojson.io. Most points are the town, not the exact
          spot. A sign nobody can place is left out; it is still in <code>signs.json</code>, with null coordinates.
        </p>
        <Fields fields={GEO_FIELDS} label="Fields of a feature in signs.geojson" />

        <h2 id="api">The API</h2>
        <p>
          The iPhone app reads and posts through the API at <code>{site}/api/v1</code>, version {API_VERSION}. These
          reads are public, JSON with snake_case keys. Its full description is{' '}
          <a href="/api/v1/openapi.json">OpenAPI 3.1 at /api/v1/openapi.json</a>. Signing in and posting are for the
          app. The API is for apps and servers; from a web page, use the files above, which any site can fetch.
        </p>
        <ul class="routes">
          {reads.map((r) => (
            <li>
              <code>GET /api/v1{r.path}</code>
              <span>{r.summary}</span>
            </li>
          ))}
        </ul>

        <h2 id="agents">For agents</h2>
        <ul>
          <li>
            <a href="/llms.txt">/llms.txt</a>: the game, the pages, the files, the feeds and every sign in a line, for
            AI tools.
          </li>
          <li>
            <a href="/llms-full.txt">/llms-full.txt</a>: every sign in full, with the numbers, every way and what each
            photo shows.
          </li>
          <li>
            <a href="/sitemap.xml">/sitemap.xml</a>: every page.
          </li>
        </ul>

        <h2 id="using">Using it</h2>
        <ul>
          <li>
            Everything here is cached for a minute, so there’s no need to fetch it more often. For a feed, once an hour
            is plenty.
          </li>
          <li>
            The format of the files is their <code>version</code>. Fields may be added; renaming or removing one moves
            the version on. The API says its version in the <code>API-Version</code> header.
          </li>
          <li>Only signs on the map are here. A sign that is held back or hidden never is.</li>
          <li>
            Everything here, the signs, the math, the places, the names and the photos, is shared under{' '}
            <a href={LICENSE.url}>{LICENSE.name}</a>: use it for anything, as long as you credit the sign’s finders and
            Road Sign Math, and link to the sign’s page. The site’s code is <a href={SOURCE_URL}>open source</a> under
            the MIT licence.
          </li>
        </ul>
      </main>
    </Page>
  );
};
