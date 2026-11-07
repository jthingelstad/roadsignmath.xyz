// Load the first-era signs (roadsignmath.com, 2005-2014) from the archive folder.
//
//   npm run seed:archive -- --archive ../rsm-mediawiki --to plan     what would load and why not
//   npm run seed:archive -- --archive ../rsm-mediawiki --to local    fill .data/ for `npm run dev`
//   ... --to plan --legacy <folder of the old site's user tables> --wiki <wiki SQL dump .gz>
//                                                                    also count address matches
//   ... --to check --legacy <folder> --wiki <dump.sql.gz>           read the live table: what a load would do
//   ... --to live --legacy <folder> --wiki <dump.sql.gz>            the live table and photo bucket
//
// Run `npm run seed -- --to local` first: Jamie's signs join the launch player. The archive and
// the old user tables stay outside this repo. Addresses are read into memory only and never
// printed, and the local store never holds a real one. `--to check` only reads. `--to live` is a
// write to live data, run once on the owner's go: it reads the table, bucket and distribution from
// the roadsignmath-xyz stack as the cloud-engineer profile, gives players their old address so
// they can claim them, leaves any sign already there alone, and clears the edge once at the end.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { CloudFrontEdgeCache } from '../src/edge-cache.ts';
import { DirPhotoStore, S3PhotoStore } from '../src/photos.ts';
import {
  buildArchivePlan,
  linkEmails,
  loadArchive,
  type ArchiveMeta,
  type ArchivePost,
  type ArchiveSeed,
  type LegacyUser
} from '../src/seed/archive.ts';
import { DynamoStore } from '../src/store/dynamo.ts';
import { MemoryStore } from '../src/store/memory.ts';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    legacy: { type: 'string' },
    wiki: { type: 'string' },
    to: { type: 'string', default: 'plan' }
  }
});
const live = values.to === 'check' || values.to === 'live';
if (
  !values.archive ||
  !['plan', 'local', 'check', 'live'].includes(values.to) ||
  (values.to === 'local' && (values.legacy || values.wiki)) ||
  (live && !values.legacy) ||
  !values.legacy !== !values.wiki
) {
  console.error('Usage: npm run seed:archive -- --archive <folder> --to plan|local');
  console.error('       Counting old addresses, with plan only: --legacy <folder> --wiki <dump.sql.gz>');
  console.error('       The live table: --to check|live --legacy <folder> --wiki <dump.sql.gz>');
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
const tally = new Map<string, number>();
for (const { why } of plan.left) tally.set(why.join(' and '), (tally.get(why.join(' and ')) ?? 0) + 1);
console.log(
  `${plan.signs.length} signs, ${plan.ways.length} ways, ${plan.photos.length} photos, ${plan.players.length} players`
);
const reasons = [...tally].sort((x, y) => y[1] - x[1]).map(([why, n]) => `${n} ${why}`);
console.log(`${plan.left.length} stay in the archive: ${reasons.join('; ')}`);
for (const { title, why } of plan.left) if (why.includes('no coordinates')) console.log(`  No coordinates: ${title}`);

const linked = values.legacy ? linkEmails(plan.players, await readLegacyUsers(values.legacy, values.wiki!)) : undefined;
if (linked) {
  console.log(
    `${linked.emails.size} players can claim with an old address, ${linked.extra} more old addresses left unlinked`
  );
  console.log(`No address found: ${linked.unmatched.join(', ') || 'none'}`);
  console.log(`An address that matches two players: ${linked.shared.join(', ') || 'none'}`);
}
if (values.to === 'plan') process.exit(0);

/** One output of the live stack, read with the AWS CLI so no name is written down here. */
function output(key: string): string {
  const query = `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--stack-name', 'roadsignmath-xyz', '--query', query];
  const value = execFileSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' }).trim();
  if (!value || value === 'None') throw new Error(`The roadsignmath-xyz stack has no ${key}`);
  return value;
}

if (live) {
  process.env.AWS_PROFILE ??= 'cloud-engineer';
  process.env.AWS_REGION ??= 'us-east-1';
  const store = new DynamoStore(output('TableName'));
  const [signs, players] = await Promise.all([store.allSigns(), store.allPlayers()]);
  const ids = new Set(signs.map((s) => s.id));
  const slugs = new Set(signs.map((s) => s.slug));
  const handles = new Set(players.map((p) => p.handle));
  const fresh = plan.signs.filter((s) => !ids.has(s.id));
  const newPlayers = plan.players.filter((p) => !p.existingHandle && !players.some((q) => q.id === p.player.id));
  let owned = 0;
  for (const p of newPlayers) {
    const email = linked!.emails.get(p.player.name);
    if (email && (await store.playerIdForEmail(email))) owned++;
  }
  const taken = fresh.filter((s) => slugs.has(s.slug)).map((s) => s.slug);
  const heldHandles = newPlayers.filter((p) => handles.has(p.player.handle)).map((p) => p.player.handle);
  console.log(`Live now: ${signs.length} signs, ${players.length} players`);
  console.log(`A load adds ${fresh.length} signs (${plan.signs.length - fresh.length} already there)`);
  console.log(`Slugs already taken, so they get -2: ${taken.join(', ') || 'none'}`);
  console.log(`Handles already taken, so they get -2: ${heldHandles.join(', ') || 'none'}`);
  console.log(`Old addresses that already have an account, so their signs go there: ${owned}`);
  for (const handle of new Set(plan.players.map((p) => p.existingHandle).filter(Boolean))) {
    if (!handles.has(handle!)) throw new Error(`No player @${handle} on the live table: load the launch signs first`);
  }
  if (values.to === 'check') process.exit(0);

  const report = await loadArchive(
    plan,
    {
      store,
      photos: new S3PhotoStore(output('PhotoBucketName')),
      read: (source) => readFile(join(values.archive!, 'images', source))
    },
    linked!.emails
  );
  await new CloudFrontEdgeCache(output('DistributionId')).clear();
  console.log(
    `Wrote ${report.added} signs and ${report.playersAdded} players to the live table; ${report.alreadyThere} signs were already there.`
  );
  if (report.creditedToExisting.length)
    console.log(`Credited to an existing account: ${report.creditedToExisting.join(', ')}`);
  console.log('Cleared the edge.');
  process.exit(0);
}

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
