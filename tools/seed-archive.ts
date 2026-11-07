// Load the first-era signs (roadsignmath.com, 2005-2014) from the archive folder.
//
//   npm run seed:archive -- --archive ../rsm-mediawiki --to plan     what would load and why not
//   npm run seed:archive -- --archive ../rsm-mediawiki --to local    fill .data/ for `npm run dev`
//   ... --to plan --legacy <folder of the old site's user tables> --wiki <wiki SQL dump .gz>
//                                                                    also count address matches
//
// Run `npm run seed -- --to local` first: Jamie's signs join the launch player. The archive and
// the old user tables stay outside this repo. Addresses are read into memory only and never
// printed, so `--legacy` only counts, and the local store never holds a real one. There is no
// live mode yet: a live load is a write to live data, added and run on the owner's go.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import yaml from 'js-yaml';
import { DirPhotoStore } from '../src/photos.ts';
import {
  buildArchivePlan,
  linkEmails,
  loadArchive,
  type ArchiveMeta,
  type ArchivePost,
  type ArchiveSeed,
  type LegacyUser
} from '../src/seed/archive.ts';
import { MemoryStore } from '../src/store/memory.ts';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    legacy: { type: 'string' },
    wiki: { type: 'string' },
    to: { type: 'string', default: 'plan' }
  }
});
if (
  !values.archive ||
  !['plan', 'local'].includes(values.to) ||
  (values.to !== 'plan' && (values.legacy || values.wiki)) ||
  !values.legacy !== !values.wiki
) {
  console.error('Usage: npm run seed:archive -- --archive <folder> --to plan|local');
  console.error('       Counting old addresses, with plan only: --legacy <folder> --wiki <dump.sql.gz>');
  process.exit(2);
}

async function readPosts(folder: string): Promise<ArchivePost[]> {
  const files = (await readdir(join(folder, 'signs'))).filter((f) => f.endsWith('.md'));
  return Promise.all(
    files.map(async (file) => {
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(await readFile(join(folder, 'signs', file), 'utf8'));
      if (!match) throw new Error(`${file} has no front matter`);
      const meta = yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) as ArchiveMeta;
      return { stem: file.slice(0, -3), meta, body: match[2] };
    })
  );
}

/** A reader for the old tables' CSV exports. A `"` opens a quote only at the start of a cell. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') cell += text[++i];
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rows.push([...row, cell]);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** The rows of one table in a MySQL dump, with its column names. */
function dumpTable(sql: string, table: string): Record<string, string>[] {
  const create = sql.slice(sql.indexOf(`CREATE TABLE \`${table}\``));
  const columns = [...create.slice(0, create.indexOf(';')).matchAll(/^\s*`(\w+)`/gm)].map((m) => m[1]);
  const rows: Record<string, string>[] = [];
  for (const insert of sql.matchAll(new RegExp(`INSERT INTO \`${table}\` VALUES (.*?);\\n`, 'gs'))) {
    let cells: string[] = [];
    let cell = '';
    let quoted = false;
    const text = insert[1];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted && ch === '\\') cell += text[++i];
      else if (ch === "'") quoted = !quoted;
      else if (quoted) cell += ch;
      else if (ch === '(') cells = [];
      else if (ch === ',' || ch === ')') {
        if (cell || text[i - 1] !== ')') cells.push(cell);
        cell = '';
        if (ch === ')') rows.push(Object.fromEntries(columns.map((c, n) => [c, cells[n] ?? ''])));
      } else cell += ch;
    }
  }
  return rows;
}

/** The old user tables, newest first. These hold addresses: nothing here prints them. */
async function readLegacyUsers(folder: string, wiki: string): Promise<LegacyUser[]> {
  const dump = gunzipSync(await readFile(wiki)).toString('latin1');
  const accounts = dumpTable(dump, 'mw_rsm_user');
  const game = parseCsv(await readFile(join(folder, 'rsmdb/rsm_users.csv'), 'latin1'));
  const blog = parseCsv(await readFile(join(folder, 'rsm/users.csv'), 'latin1'));
  return [
    ...accounts.map((r) => ({ keys: [r.user_name, r.user_real_name], email: r.user_email })),
    ...game.map((r) => ({
      keys: [
        r[1],
        [r[3], r[4]]
          .map((x) => x?.trim())
          .filter(Boolean)
          .join(' ')
      ],
      email: r[7] ?? ''
    })),
    ...blog.map((r) => ({ keys: [r[1], r[3], r[9]], email: r[4] ?? '' }))
  ].map((u) => ({ keys: u.keys.filter(Boolean), email: u.email }));
}

const posts = await readPosts(values.archive);
const seed = JSON.parse(await readFile('seed/archive.json', 'utf8')) as ArchiveSeed;
const plan = buildArchivePlan(posts, seed);

for (const sign of plan.signs) {
  console.log(`${sign.foundOn}  ${sign.postedAt.slice(0, 16)}  ${sign.title.padEnd(30)} ${sign.firstWay?.text}`);
}
const why = (reason: string): number => plan.left.filter((l) => l.why === reason).length;
console.log(
  `${plan.signs.length} signs, ${plan.ways.length} ways, ${plan.photos.length} photos, ${plan.players.length} players`
);
console.log(
  `${plan.left.length} stay in the archive: ${why('no photo')} no photo, ${why('no way the checker accepts')} no way, ${why('both')} both`
);

if (values.legacy) {
  const linked = linkEmails(plan.players, await readLegacyUsers(values.legacy, values.wiki!));
  console.log(
    `${linked.emails.size} players can claim with an old address, ${linked.extra} more old addresses left unlinked`
  );
  console.log(`No address found: ${linked.unmatched.join(', ') || 'none'}`);
  console.log(`An address that matches two players: ${linked.shared.join(', ') || 'none'}`);
}
if (values.to === 'plan') process.exit(0);

const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
const store = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();
const report = await loadArchive(plan, {
  store,
  photos: new DirPhotoStore(),
  read: (source) => readFile(join(values.archive!, 'images', source))
});
await writeFile('.data/store.json', JSON.stringify(store.snapshot(), null, 2) + '\n');
console.log(
  `Wrote ${report.added} signs and ${report.playersAdded} players; ${report.alreadyThere} signs were already there.`
);
