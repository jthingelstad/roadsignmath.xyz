// Load the 16 micro.blog signs (the launch set) from the micro.blog export.
//
//   npm run seed -- --export ../rsm-microblog --to plan    check the seed against the export
//   npm run seed -- --export ../rsm-microblog --to local   fill .data/ for `npm run dev`
//
// The export stays outside this repo; seed/microblog.json holds what the export doesn't (titles,
// finders, numbers, places, alt text). Ids come from the posts, so running it again changes
// nothing. Seeding the live table comes with the infrastructure.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { renditions } from '../src/photos.ts';
import { buildPlan, type FeedItem, type SeedFile } from '../src/seed/microblog.ts';
import { MemoryStore } from '../src/store/memory.ts';

const { values } = parseArgs({
  options: { export: { type: 'string' }, to: { type: 'string', default: 'plan' } }
});
if (!values.export || !['plan', 'local'].includes(values.to)) {
  console.error('Usage: npm run seed -- --export <micro.blog export folder> --to plan|local');
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

const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
const store = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();
const signs = new Map(plan.signs.map((s) => [s.id, s]));
for (const photo of plan.photos) {
  const sized = await renditions(await readFile(join(values.export, photo.source)));
  const dir = join('.data/photos', photo.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'large.jpg'), sized.large);
  await writeFile(join(dir, 'thumb.jpg'), sized.thumb);
  const entry = signs.get(photo.signId)!.photos.find((p) => p.id === photo.id)!;
  entry.width = sized.width;
  entry.height = sized.height;
}
for (const player of plan.players) await store.putPlayer(player);
for (const sign of plan.signs) await store.putSign(sign);
for (const way of plan.ways) await store.putWay(way);
await writeFile('.data/store.json', JSON.stringify(store.snapshot(), null, 2) + '\n');
console.log('Wrote .data/store.json and .data/photos/. Run `npm run dev` to see them.');
