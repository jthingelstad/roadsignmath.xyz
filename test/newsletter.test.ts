import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { Buttondown, MemoryNewsletter } from '../src/newsletter.ts';
import { MemoryPhotoStore } from '../src/photos.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { isFirstEraPlayer } from '../src/seed/archive.ts';
import { ulid, ulidFrom } from '../src/domain/ids.ts';
import { newsletterLease } from '../src/auth/account.ts';
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
    newsletter,
    quizOpen: true
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
  const quizSignIn = async (email: string) => {
    const form = async (path: string, fields: Record<string, string>) =>
      app.request(path, {
        method: 'POST',
        headers: {
          'X-RSM-Front': 'quiz',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://quiz.example.test'
        },
        body: new URLSearchParams(fields).toString()
      });
    // The email page goes on to the code page, whose address names the sign-in.
    const started = await form('/signin', { email });
    const code = /code is (\d{6})/.exec(mailer.sent.at(-1)!.subject)![1];
    const login = /l=([^&]+)/.exec(started.headers.get('location')!)![1];
    const done = await form('/signin/code', { login, code });
    assert.equal(done.status, 303);
  };
  return { store, newsletter, call, signIn, quizSignIn };
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

/** A fetcher that answers each call in turn. */
function scripted(...answers: [number, unknown?][]) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers[calls.length - 1] ?? [500];
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  };
  return { calls, fetcher };
}

test('an add can carry tags', async () => {
  const { calls, fetcher } = fake(201);
  assert.equal(await new Buttondown(async () => 'k', fetcher).add('new@example.com', ['quiz']), 'added');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    email_address: 'new@example.com',
    type: 'regular',
    tags: ['quiz']
  });
});

test('tags Buttondown refuses never keep a player off the list: they are added untagged', async () => {
  const { calls, fetcher } = scripted([400, { code: 'tag_invalid', detail: 'no tags on this plan' }], [201]);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    assert.equal(await new Buttondown(async () => 'k', fetcher).add('new@example.com', ['app']), 'untagged');
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { email_address: 'new@example.com', type: 'regular' });
  assert.ok(!JSON.stringify(errors).includes('new@example.com'));
  const known = scripted([400, { code: 'email_already_exists' }]);
  assert.equal(await new Buttondown(async () => 'k', known.fetcher).add('old@example.com', ['app']), 'known');
  assert.equal(known.calls.length, 1);
});

test('a tag keeps the subscriber’s tags: it reads them, then writes them back with the new one', async () => {
  const { calls, fetcher } = scripted([200, { email_address: 'a+b@example.com', tags: ['vip'] }], [200]);
  assert.equal(await new Buttondown(async () => 'k', fetcher).tag('a+b@example.com', ['quiz']), 'tagged');
  assert.equal(calls[0]!.url, 'https://api.buttondown.com/v1/subscribers/a%2Bb%40example.com');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[1]!.url, 'https://api.buttondown.com/v1/subscribers/a%2Bb%40example.com');
  assert.equal(calls[1]!.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { tags: ['vip', 'quiz'] }, 'tags only: never its type');

  const already = scripted([200, { tags: ['quiz', 'app'] }]);
  assert.equal(await new Buttondown(async () => 'k', already.fetcher).tag('a@example.com', ['app']), 'already');
  assert.equal(already.calls.length, 1, 'nothing written');
  assert.equal(await new Buttondown(async () => 'k', scripted([404]).fetcher).tag('x@example.com', ['app']), 'gone');
  assert.equal(await new Buttondown(async () => undefined, scripted().fetcher).tag('x@example.com', ['app']), 'off');
});

test('a failed tag never throws and never logs the address', async () => {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const refused = scripted([200, { tags: [] }], [400, { code: 'tag_invalid' }]);
    assert.equal(
      await new Buttondown(async () => 'k', refused.fetcher).tag('secret.person@example.com', ['app']),
      'failed'
    );
    const odd = scripted([200, { email_address: 'secret.person@example.com' }]);
    assert.equal(
      await new Buttondown(async () => 'k', odd.fetcher).tag('secret.person@example.com', ['app']),
      'failed'
    );
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  assert.ok(!JSON.stringify(logged).includes('secret.person'));
});

test('a new player in the app joins tagged app, and the player row keeps the tag', async () => {
  const t = setup();
  await t.signIn('pat@example.com');
  assert.deepEqual([...t.newsletter.tags.get('pat@example.com')!], ['app']);
  const id = (await t.store.playerIdForEmail('pat@example.com'))!;
  assert.deepEqual((await t.store.getPlayer(id))!.newsletterTags, ['app']);
  assert.deepEqual(
    (await t.store.sessionsOf(id)).map((s) => s.via),
    ['app']
  );
});

test('a new player in Quiz joins tagged quiz, and an app player who signs in to Quiz gains quiz', async () => {
  const t = setup();
  await t.quizSignIn('quinn@example.com');
  assert.deepEqual([...t.newsletter.tags.get('quinn@example.com')!], ['quiz']);

  await t.signIn('pat@example.com');
  await t.quizSignIn('pat@example.com');
  assert.deepEqual([...t.newsletter.tags.get('pat@example.com')!], ['app', 'quiz']);
  const id = (await t.store.playerIdForEmail('pat@example.com'))!;
  assert.deepEqual((await t.store.getPlayer(id))!.newsletterTags, ['app', 'quiz']);
  assert.deepEqual((await t.store.sessionsOf(id)).map((s) => s.via).sort(), ['app', 'quiz']);
});

test('a player already on the list is tagged at sign-in, once; a missed tag is tried again next time', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  const newsletter = new MemoryNewsletter();
  newsletter.list.add(ada.email!);
  let down = true;
  const tag = newsletter.tag.bind(newsletter);
  let tries = 0;
  newsletter.tag = async (email, tags) => {
    tries++;
    return down ? 'failed' : tag(email, tags);
  };
  const t = setup(store, newsletter);
  await t.signIn(ada.email!);
  assert.equal((await store.getPlayer(ada.id))!.newsletterTags, undefined, 'a missed tag isn’t recorded');
  down = false;
  await t.signIn(ada.email!);
  assert.deepEqual((await store.getPlayer(ada.id))!.newsletterTags, ['app']);
  assert.deepEqual([...newsletter.tags.get(ada.email!)!], ['app']);
  await t.signIn(ada.email!);
  assert.equal(tries, 2, 'a recorded tag is never asked for again');
  assert.equal(newsletter.list.size, 1, 'no one is added twice');
});

test('first-era players are the archive’s, by the time in their id', () => {
  assert.ok(isFirstEraPlayer(ulidFrom(Date.parse('2005-02-13T00:00:00Z'), 'archive-player:Ben Example')));
  assert.ok(!isFirstEraPlayer(ulid()));
  assert.ok(!isFirstEraPlayer(ada.id));
});

test('a new player added without their tag is not recorded as tagged, so it is tried again', async () => {
  const newsletter = new MemoryNewsletter();
  const add = newsletter.add.bind(newsletter);
  let refuse = true;
  newsletter.add = async (email) => ((await add(email)) === 'added' && refuse ? 'untagged' : add(email));
  const tag = newsletter.tag.bind(newsletter);
  newsletter.tag = async (email, tags) => (refuse ? 'failed' : tag(email, tags));
  const t = setup(new MemoryStore(), newsletter);
  await t.signIn('pat@example.com');
  assert.ok(newsletter.list.has('pat@example.com'), 'on the list all the same');
  const id = (await t.store.playerIdForEmail('pat@example.com'))!;
  assert.equal((await t.store.getPlayer(id))!.newsletterTags, undefined);
  refuse = false;
  await t.signIn('pat@example.com');
  assert.deepEqual((await t.store.getPlayer(id))!.newsletterTags, ['app']);
  assert.deepEqual([...newsletter.tags.get('pat@example.com')!], ['app']);
});

test('one tag change at a time per player: a sign-in that finds the lease held leaves it for next time', async () => {
  const store = new MemoryStore();
  await addPlayer(store, ada);
  const newsletter = new MemoryNewsletter();
  newsletter.list.add(ada.email!);
  const t = setup(store, newsletter);
  assert.ok(await store.lease(newsletterLease(ada.id), 'someone-else', 30));
  await t.signIn(ada.email!);
  assert.equal(newsletter.tags.get(ada.email!), undefined, 'nothing written while another holds it');
  assert.equal((await store.getPlayer(ada.id))!.newsletterTags, undefined);
  await store.endLease(newsletterLease(ada.id), 'someone-else');
  await t.signIn(ada.email!);
  assert.deepEqual([...newsletter.tags.get(ada.email!)!], ['app']);
  assert.ok(await store.lease(newsletterLease(ada.id), 'after', 30), 'the sign-in gave its lease back');
});
