import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { Buttondown, MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { addPlayer } from '../src/store/store.ts';
import { ada } from './support/fixtures.ts';
import { ScriptedModerator } from './support/moderator.ts';

type Call = { url: string; init: RequestInit };

function fake(status: number) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : '{}', { status });
  };
  return { calls, fetcher };
}

test('an add is a regular subscriber with no collision header, so no one is resubscribed', async () => {
  const { calls, fetcher } = fake(201);
  const newsletter = new Buttondown(async () => 'test-key', fetcher);
  assert.equal(await newsletter.add('new.player@example.com'), 'added');
  assert.equal(calls[0]!.url, 'https://api.buttondown.com/v1/subscribers');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Token test-key');
  assert.ok(!Object.keys(headers).some((h) => h.toLowerCase().startsWith('x-buttondown')));
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    email_address: 'new.player@example.com',
    type: 'regular'
  });
});

test('an address Buttondown already has is known and left alone', async () => {
  const { fetcher } = fake(400);
  assert.equal(await new Buttondown(async () => 'k', fetcher).add('old@example.com'), 'known');
});

test('without a key nothing is sent', async () => {
  const { calls, fetcher } = fake(201);
  const newsletter = new Buttondown(async () => undefined, fetcher);
  assert.equal(await newsletter.add('a@example.com'), 'off');
  assert.equal(await newsletter.remove('a@example.com'), 'off');
  assert.equal(calls.length, 0);
});

test('a remove deletes the subscriber by address; one not there is gone', async () => {
  const removed = fake(204);
  assert.equal(await new Buttondown(async () => 'k', removed.fetcher).remove('a+b@example.com'), 'removed');
  assert.equal(removed.calls[0]!.url, 'https://api.buttondown.com/v1/subscribers/a%2Bb%40example.com');
  assert.equal(removed.calls[0]!.init.method, 'DELETE');
  assert.equal(await new Buttondown(async () => 'k', fake(404).fetcher).remove('x@example.com'), 'gone');
});

test('a failure never throws and never logs the address', async () => {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const down = new Buttondown(
      async () => 'k',
      async () => {
        throw new TypeError('fetch failed');
      }
    );
    assert.equal(await down.add('secret.person@example.com'), 'failed');
    assert.equal(
      await new Buttondown(async () => 'k', fake(500).fetcher).remove('secret.person@example.com'),
      'failed'
    );
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  assert.ok(!JSON.stringify(logged).includes('secret.person'));
});

function setup(store = new MemoryStore(), newsletter = new MemoryNewsletter()) {
  const mailer = new MemoryMailer();
  const app = createApp({
    store,
    urls: { site: 'https://example.test' },
    mailer,
    photos: new MemoryPhotoStore(),
    moderator: new ScriptedModerator(),
    clientIp: () => '192.0.2.1',
    newsletter
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    // oxlint-disable-next-line no-explicit-any -- test bodies are read loosely
    return { res, body: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const signIn = async (email: string) => {
    const started = await call('POST', '/auth/start', { email });
    const code = /code is (\d{6})/.exec(mailer.sent.at(-1)!.subject)![1];
    return (await call('POST', '/auth/verify', { login_id: started.body.login_id, code })).body;
  };
  return { store, newsletter, call, signIn };
}

test('a new player joins the newsletter at their first sign-in, and leaves it when they delete their account', async () => {
  const t = setup();
  const done = await t.signIn('New.Player@Example.com');
  assert.equal(done.new_player, true);
  assert.deepEqual([...t.newsletter.list], ['new.player@example.com']);
  assert.equal((await t.call('DELETE', '/me', undefined, done.token)).res.status, 204);
  assert.deepEqual([...t.newsletter.list], []);
});

test('a player already in the game is not added again at sign-in', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  const t = setup(store);
  const done = await t.signIn(ada.email!);
  assert.equal(done.new_player, false);
  assert.equal(t.newsletter.list.size, 0);
});

test('a new player who once unsubscribed stays unsubscribed', async () => {
  const newsletter = new MemoryNewsletter();
  newsletter.unsubscribed.add('back.again@example.com');
  const t = setup(new MemoryStore(), newsletter);
  await t.signIn('back.again@example.com');
  assert.equal(newsletter.list.size, 0);
  assert.ok(newsletter.unsubscribed.has('back.again@example.com'));
});
