// `npm run dev`: the server on http://localhost:8787 with an in-memory store, loaded from
// .data/store.json when it exists (the seed script writes it). Photos come from
// .data/photos/<photoId>/<size>.jpg. Sign-in emails land in .data/mail/. Nothing here touches
// AWS, and sign-ins last only as long as the process.

import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.ts';
import { FileMailer } from './mail/mailer.ts';
import { MemoryStore } from './store/memory.ts';

const port = Number(process.env.PORT ?? 8787);
const site = `http://localhost:${port}`;

const saved = await readFile('.data/store.json', 'utf8').catch(() => undefined);
const store = saved ? await MemoryStore.from(JSON.parse(saved)) : new MemoryStore();

const app = createApp({ store, urls: { site }, mailer: new FileMailer(), clientIp: () => 'local' });
app.get('/p/:photo/:file', async (c) => {
  const { photo, file } = c.req.param();
  if (!/^[\w-]+$/.test(photo) || !/^(large|thumb)\.jpg$/.test(file)) return c.notFound();
  const bytes = await readFile(`.data/photos/${photo}/${file}`).catch(() => undefined);
  return bytes ? c.body(bytes, 200, { 'Content-Type': 'image/jpeg' }) : c.notFound();
});

serve({ fetch: app.fetch, port }, () => {
  const count = saved ? 'from .data/store.json' : 'empty (run the seed script to fill it)';
  console.log(`Road Sign Math on ${site}/api/v1, store ${count}`);
});
