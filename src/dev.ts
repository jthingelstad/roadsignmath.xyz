// `npm run dev`: the server on http://localhost:8787 with an in-memory store, loaded from
// .data/store.json when it exists (the seed script writes it). Photos come from
// .data/photos/<photoId>/<size>.jpg and uploads wait in .data/uploads/. Sign-in emails and
// feedback land in .data/mail/. Posts pass a moderator that lets everything through, unless
// ANTHROPIC_API_KEY is set, when Claude moderates as it does live. Hearts are off (no
// Tinylytics, so counts are null) and app views are dropped. Nothing else leaves the machine,
// and sign-ins and posts last only as long as the process. Quiz answers on the next port
// (http://localhost:8788), open whatever `QUIZ_OPEN` says, from the same store.

import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp } from './api/app.ts';
import { FRONT_HEADER } from './front.ts';
import { FileMailer } from './mail/mailer.ts';
import { ClaudeModerator, LenientModerator } from './moderation/moderator.ts';
import { DirPhotoStore } from './photos.ts';
import { MemoryStore } from './store/memory.ts';

const port = Number(process.env.PORT ?? 8787);
const site = `http://localhost:${port}`;
const quizPort = port + 1;
const quiz = `http://localhost:${quizPort}`;

const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
const store = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();

const key = process.env.ANTHROPIC_API_KEY;
const photos = new DirPhotoStore();
const moderator = key ? new ClaudeModerator(key) : new LenientModerator();
// APPLE_TEAM_ID, when set, serves the apple-app-site-association as the live site does.
const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || undefined;
const server = createApp({
  store,
  urls: { site, quiz },
  quizOpen: true,
  mailer: new FileMailer(),
  photos,
  moderator,
  clientIp: () => 'local',
  appleTeamId,
  feedbackTo: process.env.FEEDBACK_TO?.trim() || 'feedback@example.test'
});
// The photos, ahead of the server: its fronts take every other address.
const app = new Hono();
app.get('/p/:photo/:file', async (c) => {
  const { photo, file } = c.req.param();
  const size = /^(large|thumb)\.jpg$/.exec(file)?.[1] as 'large' | 'thumb' | undefined;
  if (!/^[\w-]+$/.test(photo) || !size) return c.notFound();
  const bytes = await photos.get(photo, size, 'shown');
  return bytes ? c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' }) : c.notFound();
});
app.all('*', (c) => server.fetch(c.req.raw));

// Quiz's port says so as Quiz's distribution does (src/front.ts).
serve(
  {
    fetch: (req) => {
      const headers = new Headers(req.headers);
      headers.set(FRONT_HEADER, 'quiz');
      return app.fetch(new Request(req, { headers }));
    },
    port: quizPort
  },
  () => console.log(`Road Sign Math Quiz on ${quiz}`)
);

serve({ fetch: app.fetch, port }, () => {
  const count = saved ? 'from .data/store.json' : 'empty (run the seed script to fill it)';
  console.log(`Road Sign Math on ${site}/api/v1, store ${count}, ${key ? 'Claude' : 'no'} moderation`);
});
