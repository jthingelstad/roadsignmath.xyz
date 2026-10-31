// /llms.txt and /llms-full.txt (llmstxt.org) for agents and the people who use them.
//
// llms.txt keeps the shape the reference parser reads (llms-txt's parse_llms_file): "# Title",
// the "> summary" and prose with no headings, then sections where every line is
// "- [name](url): note" with one link. A line without a link stops that parser, and a second link
// on a line is lost; a name ends at its first "]", so brackets in names become parentheses.
// llms-full.txt is plain Markdown: every sign in full.

import { STATES } from '../domain/geo.ts';
import { playerStats } from '../api/views.ts';
import { signRecord, type OpenData } from './data.ts';
import { FEED_SIZE } from './feeds.ts';
import { ARCHIVE_URL, longDay, TESTFLIGHT_URL } from './layout.tsx';

export const SOURCE_URL = 'https://github.com/jthingelstad/roadsignmath.xyz';

const linkName = (name: string): string => name.replace(/\[/g, '(').replace(/\]/g, ')');
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const names = (list: string[]): string =>
  list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

function shape(data: OpenData) {
  const states = new Set(data.signs.map((s) => s.place.state).filter(Boolean));
  const years = data.signs.map((s) => s.foundOn.slice(0, 4)).sort();
  return { states: states.size, first: years[0], last: years.at(-1) };
}

const GAME = [
  'A way is accepted when the math is true and every number in it is one of the numbers on the sign, each used no more often than the sign shows it. Using every number is encouraged, not required. Anyone can find another way on any sign. There are no points, scores or rankings.',
  'Jamie Thingelstad started the game in 2005 as roadsignmath.com, with signs sent in by other players until 2014. This site and the iPhone app are its new era; the first era’s signs are kept in the archive on Things I’ve built, not here.',
  'Each sign has a page at `/signs/<slug>` and each player at `/players/<handle>`. Most places are approximate: the pin sits on the town the post or the sign names. `found_on` is the day in the finder’s own time; other times are UTC.'
];

export function llmsTxt(data: OpenData): string {
  const site = data.urls.site;
  const { states, first, last } = shape(data);
  const span = first && last ? (first === last ? ` in ${first}` : ` from ${first} to ${last}`) : '';
  const lines = [
    '# Road Sign Math',
    '',
    `> A road trip game: find a road sign whose numbers make a true equation, photograph it, write the math, and post it to the map. ${plural(data.signs.length, 'sign')} from ${plural(data.players.length, 'player')} in ${plural(states, 'state')}, found${span}.`,
    '',
    ...GAME.flatMap((p) => [p, '']),
    '## Data',
    '',
    `- [Every sign](${site}/signs.json): every shown sign, newest posted first, with its numbers, every way to make it true (as text and LaTeX), the place and coordinates, the finders, the dates and both photo sizes; open to any origin`,
    `- [Players](${site}/players.json): everyone with a sign or a badge on the map, with their counts, states, signs and badges`,
    `- [Signs on a map](${site}/signs.geojson): a GeoJSON FeatureCollection with a point for every sign that has a place`,
    `- [Feeds and data](${site}/data): how to use the feeds, the files and the API, with every field documented`,
    '',
    '## Feeds',
    '',
    `- [Atom feed](${site}/feed.xml): the newest ${FEED_SIZE} signs; every player has their own at \`/players/<handle>/feed.xml\``,
    `- [JSON Feed](${site}/feed.json): the same signs as JSON Feed 1.1; every player has their own at \`/players/<handle>/feed.json\``,
    '',
    '## API',
    '',
    `- [API](${site}/api/v1): public JSON reads under \`/api/v1\` (signs, a sign and its ways, signs near a point, the map, players, badges); posting is for the iPhone app`,
    `- [OpenAPI description](${site}/api/v1/openapi.json): every route, parameter and field (OpenAPI 3.1)`,
    '',
    '## Pages',
    '',
    `- [Home](${site}/): the map of every sign with a year filter, who’s playing, the latest signs, how to play and the app`,
    `- [About](${site}/about): the game’s story, from 2005 to the app, in Jamie’s words`,
    `- [Feeds and data](${site}/data): the feeds, the open files and the API for anyone building with the signs`,
    `- [Privacy](${site}/privacy): what the game keeps and who sees it`,
    `- [iPhone app beta](${TESTFLIGHT_URL}): the app, where the game is played, through Apple’s TestFlight`,
    ''
  ];
  if (data.players.length) {
    lines.push('## Players', '');
    for (const player of data.players) {
      const stats = playerStats(player, data.signs);
      const since = stats.first_year ? ` since ${stats.first_year}` : '';
      lines.push(
        `- [${linkName(player.name)}](${site}/players/${player.handle}): ${plural(stats.sign_count, 'sign')} in ${plural(stats.states.length, 'state')}${since}`
      );
    }
    lines.push('');
  }
  if (data.signs.length) {
    lines.push('## Signs', '');
    for (const sign of data.signs) {
      const r = signRecord(data, sign);
      const math = r.ways[0] ? `${r.ways[0].text}.` : 'Not solved yet.';
      lines.push(
        `- [${linkName(r.title)}](${r.url}): ${math} ${r.place.label}, ${longDay(r.found_on)}. Found by ${names(r.finders.map((f) => f.name))}.`
      );
    }
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    `- [Full text](${site}/llms-full.txt): every sign in full: the numbers and what each was read from, every way and who found it, and what each photo shows`,
    `- [Sitemap](${site}/sitemap.xml): every page`,
    `- [The first era](${ARCHIVE_URL}): Road Sign Math from 2005 to 2014, on Things I’ve built`,
    `- [Source code](${SOURCE_URL}): this site and its API, MIT licensed`,
    ''
  );
  return lines.join('\n');
}

const ROLE: Record<string, string> = { found: 'found it', took_photo: 'took the photo', spotted: 'spotted it' };

export function llmsFullTxt(data: OpenData): string {
  const site = data.urls.site;
  const out = [
    '# Road Sign Math: every sign in full',
    '',
    `> Every sign on ${site}, newest posted first. The short index is ${site}/llms.txt; the same data as JSON is ${site}/signs.json.`,
    '',
    ...GAME.flatMap((p) => [p, ''])
  ];
  for (const sign of data.signs) {
    const r = signRecord(data, sign);
    const state = r.place.state ? (STATES[r.place.state] ?? r.place.state) : null;
    const where =
      r.place.lat !== null && r.place.lng !== null
        ? `${r.place.label} (${r.place.lat}, ${r.place.lng}${r.place.approximate ? ', approximate: the town, not the exact spot' : ''})`
        : `${r.place.label} (not on the map)`;
    out.push(`## ${r.title}`, '');
    out.push(`- Page: ${r.url}`);
    out.push(`- Found: ${longDay(r.found_on)}`);
    out.push(`- Where: ${where}${state && !r.place.label.includes(state) ? `, ${state}` : ''}`);
    out.push(`- Finders: ${r.finders.map((f) => `${f.name} (${ROLE[f.role] ?? f.role})`).join(', ')}`);
    if (r.numbers.length) {
      out.push(
        `- Numbers on the sign: ${r.numbers
          .map((n) =>
            n.text && n.text !== n.value ? `${n.value} (from “${n.text}”${n.why ? `, ${n.why}` : ''})` : n.value
          )
          .join(', ')}`
      );
    }
    if (r.caption) out.push(`- Caption: ${r.caption}`);
    if (r.ways.length) {
      out.push(`- Ways to make it true:`);
      for (const w of r.ways) {
        out.push(`  - ${w.text} (both sides are ${w.value})${w.by ? `, by ${w.by.name || w.by.handle}` : ''}`);
      }
    } else {
      out.push('- Ways to make it true: none yet');
    }
    for (const [i, p] of r.photos.entries()) {
      out.push(`- Photo${r.photos.length > 1 ? ` ${i + 1}` : ''}: ${p.alt} (${p.url})`);
    }
    out.push('');
  }
  return out.join('\n');
}
