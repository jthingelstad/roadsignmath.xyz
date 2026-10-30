// `npm run dev`: the server on http://localhost:8787 with an in-memory store, loaded from
// .data/store.json when it exists (the seed script writes it). Photos come from
// .data/photos/<photoId>/<size>.jpg and uploads wait in .data/uploads/. Sign-in emails land in
// .data/mail/. Posts pass a moderator that lets everything through, unless
// ANTHROPIC_API_KEY is set, when Claude moderates as it does live. Nothing else leaves the
// machine, and sign-ins and posts last only as long as the process.

import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.ts';
import { FileMailer } from './mail/mailer.ts';
import { ClaudeModerator, LenientModerator } from './moderation/moderator.ts';
import { DirPhotoStore } from './photos.ts';
import { MemoryStore } from './store/memory.ts';

const port = Number(process.env.PORT ?? 8787);
const site = `http://localhost:${port}`;

const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
const store = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();

const key = process.env.ANTHROPIC_API_KEY;
const photos = new DirPhotoStore();
const moderator = key ? new ClaudeModerator(key) : new LenientModerator();
// APPLE_TEAM_ID, when set, serves the apple-app-site-association as the live site does.
const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || undefined;
const app = createApp({
  store,
  urls: { site },
  mailer: new FileMailer(),
  photos,
  moderator,
  clientIp: () => 'local',
  appleTeamId
});
app.get('/p/:photo/:file', async (c) => {
  const { photo, file } = c.req.param();
  const size = /^(large|thumb)\.jpg$/.exec(file)?.[1] as 'large' | 'thumb' | undefined;
  if (!/^[\w-]+$/.test(photo) || !size) return c.notFound();
  const bytes = await photos.get(photo, size, 'shown');
  return bytes ? c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' }) : c.notFound();
});

serve({ fetch: app.fetch, port }, () => {
  const count = saved ? 'from .data/store.json' : 'empty (run the seed script to fill it)';
  console.log(`Road Sign Math on ${site}/api/v1, store ${count}, ${key ? 'Claude' : 'no'} moderation`);
});
