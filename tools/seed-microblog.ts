// Load the 16 micro.blog signs (the launch set) from the micro.blog export.
//
//   npm run seed -- --export ../rsm-microblog --to plan    check the seed against the export
//   npm run seed -- --export ../rsm-microblog --to local   fill .data/ for `npm run dev`
//   npm run seed -- --export ../rsm-microblog --to live    the live table and photo bucket
//
// The export stays outside this repo; seed/microblog.json holds what the export doesn't (titles,
// finders, numbers, places, alt text). Ids come from the posts, so running it again changes
// nothing. `--to live` is a write to live data, done once on the owner's go: it reads the table
// and bucket from the roadsignmath-xyz stack as the cloud-engineer profile, and leaves alone any
// sign already there, so a second run writes nothing.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { DirPhotoStore, S3PhotoStore, renditions, type PhotoStore } from '../src/photos.ts';
import { buildPlan, type FeedItem, type SeedFile } from '../src/seed/microblog.ts';
import { DynamoStore } from '../src/store/dynamo.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer, addSign, type Store } from '../src/store/store.ts';

const { values } = parseArgs({
  options: { export: { type: 'string' }, to: { type: 'string', default: 'plan' } }
});
if (!values.export || !['plan', 'local', 'live'].includes(values.to)) {
  console.error('Usage: npm run seed -- --export <micro.blog export folder> --to plan|local|live');
  process.exit(2);
}

const feed = JSON.parse(await readFile(join(values.export, 'feed.json'), 'utf8')) as { items: FeedItem[] };
const seed = JSON.parse(await readFile('seed/microblog.json', 'utf8')) as SeedFile;
const plan = buildPlan(feed.items, seed);

for (const sign of plan.signs) {
  const finder = sign.finders.map((f) => f.name).join(', ');
  const pin = sign.place.lat === undefined ? 'no pin' : `${sign.place.lat}, ${sign.place.lng}`;
  console.log(`${sign.foundOn}  ${sign.title.padEnd(26)} ${finder.padEnd(6)} ${sign.firstWay?.text}  (${pin})`);
}
console.log(`${plan.signs.length} signs, ${plan.photos.length} photos, ${plan.players.length} players`);
if (values.to === 'plan') process.exit(0);

/** One output of the live stack, read with the AWS CLI so no name is written down here. */
function output(key: string): string {
  const query = `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--stack-name', 'roadsignmath-xyz', '--query', query];
  const value = execFileSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' }).trim();
  if (!value || value === 'None') throw new Error(`The roadsignmath-xyz stack has no ${key}`);
  return value;
}

let store: Store;
let photos: PhotoStore;
let memory: MemoryStore | undefined;
if (values.to === 'live') {
  process.env.AWS_PROFILE ??= 'cloud-engineer';
  process.env.AWS_REGION ??= 'us-east-1';
  store = new DynamoStore(output('TableName'));
  photos = new S3PhotoStore(output('PhotoBucketName'));
} else {
  const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
  memory = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();
  store = memory;
  photos = new DirPhotoStore();
}
// A sign already there is left as it is, with its photos and ways: players may have added to it.
const present = new Set<string>();
for (const sign of plan.signs) if (await store.getSign(sign.id)) present.add(sign.id);
const signs = new Map(plan.signs.map((s) => [s.id, s]));
for (const photo of plan.photos) {
  if (present.has(photo.signId)) continue;
  const sized = await renditions(await readFile(join(values.export, photo.source)));
  await photos.putUpload(photo.id, sized);
  await photos.publish(photo.id, 'shown');
  const entry = signs.get(photo.signId)!.photos.find((p) => p.id === photo.id)!;
  entry.width = sized.width;
  entry.height = sized.height;
}
for (const player of plan.players) if (!(await store.getPlayer(player.id))) await addPlayer(store, player);
// Ways before their sign, as a post does, so a sign is never public without its first way.
for (const way of plan.ways) {
  if (present.has(way.signId)) continue;
  await store.claimWay(way.signId, way.text, way.id);
  await store.putWay(way);
}
for (const sign of plan.signs) if (!present.has(sign.id)) await addSign(store, sign);
const added = plan.signs.length - present.size;
if (memory) {
  await writeFile('.data/store.json', JSON.stringify(memory.snapshot(), null, 2) + '\n');
  console.log(`Wrote ${added} signs to .data/store.json and .data/photos/. Run \`npm run dev\` to see them.`);
} else {
  console.log(`Wrote ${added} signs to the live table and bucket; ${present.size} were already there.`);
}
