// Puts every player the game has an address for on the players' newsletter, with their tags. Run
// once for the players from before the server added new ones itself (Jamie, 2026-11-07: "include
// ALL players that we have in the system"), and once more to tag the list (Jamie, 2026-11-12:
// "Approved: add Buttondown tags for Quiz players and tag the existing list once"). After that the
// server adds and tags each player at their sign-in.
//
//   BUTTONDOWN_API_KEY=… npm run newsletter -- --to check    read only: how many would change
//   BUTTONDOWN_API_KEY=… npm run newsletter -- --to live     add and tag them (a live write: the owner's go)
//
// A player's tags: `first-era` for the archive's 2005-2014 players, and `app` or `quiz` for each
// place they have a live session (one from before sessions recorded it was the app). Tags are only
// added, never taken off.
//
// Give the key through the environment (`op run`), never on the command line. It reads the live
// table as the cloud-engineer profile and writes nothing to it. Addresses are read into memory
// only: never printed, logged or saved; the tool prints counts. An address Buttondown already has,
// unsubscribed included, is never resubscribed, so running it again changes nothing twice.

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buttondown, type NewsletterTag } from '../src/newsletter.ts';
import { isFirstEraPlayer } from '../src/seed/archive.ts';
import { DynamoStore } from '../src/store/dynamo.ts';

/** Buttondown takes 100 new subscribers a day from one key at first; stay under it. */
const DAILY = 90;

const { values } = parseArgs({ options: { to: { type: 'string' } } });
if (values.to !== 'check' && values.to !== 'live') {
  console.error('Usage: BUTTONDOWN_API_KEY=… npm run newsletter -- --to check|live');
  process.exit(64);
}
const key = process.env.BUTTONDOWN_API_KEY?.trim();
if (!key) {
  console.error('BUTTONDOWN_API_KEY is not set. Give it through the environment, for example with `op run`.');
  process.exit(64);
}

function output(name: string): string {
  const query = `Stacks[0].Outputs[?OutputKey=='${name}'].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--stack-name', 'roadsignmath-xyz', '--query', query];
  const value = execFileSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' }).trim();
  if (!value || value === 'None') throw new Error(`The roadsignmath-xyz stack has no ${name}`);
  return value;
}

process.env.AWS_PROFILE ??= 'cloud-engineer';
process.env.AWS_REGION ??= 'us-east-1';
const store = new DynamoStore(output('TableName'));
const players = await store.allPlayers();

/** Each address and the tags it should have. */
const wanted = new Map<string, Set<NewsletterTag>>();
for (const player of players) {
  const email = player.email?.trim().toLowerCase();
  if (!email) continue;
  const tags = wanted.get(email) ?? new Set<NewsletterTag>();
  wanted.set(email, tags);
  if (isFirstEraPlayer(player.id)) tags.add('first-era');
  for (const session of await store.sessionsOf(player.id)) tags.add(session.via ?? 'app');
}

/** The subscriber's tags, or undefined when Buttondown doesn't have the address: a read. */
async function subscriber(email: string): Promise<string[] | undefined> {
  const res = await fetch(`https://api.buttondown.com/v1/subscribers/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Buttondown answered ${res.status} to a subscriber read`);
  }
  const tags: unknown = ((await res.json()) as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) throw new Error('Buttondown answered a subscriber read without tags');
  return tags.filter((t): t is string => typeof t === 'string');
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const count = (into: Record<string, number>, name: string) => (into[name] = (into[name] ?? 0) + 1);

const toAdd: [string, NewsletterTag[]][] = [];
const toTag: [string, NewsletterTag[]][] = [];
const missingTags: Record<string, number> = {};
const hasTags: Record<string, number> = {};
for (const [email, tags] of wanted) {
  const have = await subscriber(email);
  const missing = [...tags].filter((t) => !have?.includes(t));
  for (const t of have ?? []) count(hasTags, t);
  for (const t of missing) count(missingTags, t);
  if (!have) toAdd.push([email, [...tags]]);
  else if (missing.length) toTag.push([email, missing]);
  await pause(250);
}
console.log(`${players.length} players, ${wanted.size} with an address`);
console.log(`${wanted.size - toAdd.length} already on the newsletter (any state), ${toAdd.length} to add`);
console.log(`tags on the list now: ${JSON.stringify(hasTags)}`);
console.log(`${toTag.length} to tag; tags to add (new subscribers included): ${JSON.stringify(missingTags)}`);
if (values.to === 'check') process.exit(0);

const newsletter = new Buttondown(async () => key);
const added: Record<string, number> = {};
for (const [email, tags] of toAdd.slice(0, DAILY)) {
  count(added, await newsletter.add(email, tags, 10_000));
  await pause(1000);
}
const tagged: Record<string, number> = {};
for (const [email, tags] of toTag) {
  const outcome = await newsletter.tag(email, tags, 10_000);
  count(tagged, outcome);
  // A tag Buttondown won't take (a plan without tags, say) fails them all: stop at the first.
  if (outcome === 'failed') break;
  await pause(1000);
}
console.log('added:', JSON.stringify(added));
console.log('tagged:', JSON.stringify(tagged));
if (toAdd.length > DAILY) console.log(`${toAdd.length - DAILY} left to add tomorrow: run it again then.`);
