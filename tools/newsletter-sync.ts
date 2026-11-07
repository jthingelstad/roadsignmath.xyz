// Puts every player the game has an address for on the players' newsletter, once: the players
// from before the server added new ones itself (Jamie, 2026-11-07: "include ALL players that we
// have in the system"). After this, the server adds each new player at their first sign-in.
//
//   BUTTONDOWN_API_KEY=… npm run newsletter -- --to check    read only: how many would be added
//   BUTTONDOWN_API_KEY=… npm run newsletter -- --to live     add them (a live write: the owner's go)
//
// Give the key through the environment (`op run`), never on the command line. It reads the live
// table as the cloud-engineer profile. Addresses are read into memory only: never printed, logged
// or saved; the tool prints counts. An address Buttondown already has, unsubscribed included, is
// left as it is, so running it again adds no one twice and resubscribes no one.

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buttondown } from '../src/newsletter.ts';
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
const players = await new DynamoStore(output('TableName')).allPlayers();
const emails = [...new Set(players.map((p) => p.email?.trim().toLowerCase()).filter((e): e is string => !!e))];

/** Whether Buttondown has the address already, in any state: a read. */
async function known(email: string): Promise<boolean> {
  const res = await fetch(`https://api.buttondown.com/v1/subscribers/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`Buttondown answered ${res.status} to a subscriber read`);
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

let onList = 0;
const missing: string[] = [];
for (const email of emails) {
  if (await known(email)) onList++;
  else missing.push(email);
  await pause(250);
}
console.log(`${players.length} players, ${emails.length} with an address`);
console.log(`${onList} already on the newsletter (any state), ${missing.length} to add`);
if (values.to === 'check') process.exit(0);

const newsletter = new Buttondown(async () => key);
const counts: Record<string, number> = {};
for (const email of missing.slice(0, DAILY)) {
  const outcome = await newsletter.add(email, 10_000);
  counts[outcome] = (counts[outcome] ?? 0) + 1;
  await pause(1000);
}
console.log('added:', JSON.stringify(counts));
if (missing.length > DAILY) console.log(`${missing.length - DAILY} left for tomorrow: run it again then.`);
