import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedTinylytics, kudoWindows, TinylyticsUnavailable } from '../src/tinylytics.ts';

// Made up: a key shaped like a full-access one. Nothing here reaches the network.
const KEY = 'tly-fa-example-not-a-real-key';

type Sent = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function client(answer: (sent: Sent) => { status: number; json?: unknown } | Error, key: string | null = KEY) {
  const sent: Sent[] = [];
  let keyReads = 0;
  const now = { ms: Date.parse('2026-11-02T15:00:00Z') };
  const tinylytics = new KeyedTinylytics(
    async () => {
      keyReads++;
      return key ?? undefined;
    },
    async (url, init) => {
      const one: Sent = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(init.body as string)
      };
      sent.push(one);
      const out = answer(one);
      if (out instanceof Error) throw out;
      return new Response(out.json === undefined ? null : JSON.stringify(out.json), { status: out.status });
    },
    1525,
    () => now.ms
  );
  return { tinylytics, sent, keyReads: () => keyReads, now };
}

test('a kudo is made and removed with the key, a User-Agent and the uid', async () => {
  const { tinylytics, sent } = client((s) => ({ status: s.method === 'POST' ? 201 : 404 }));
  await tinylytics.addKudo('/signs/exit-7', 'rsm-abc');
  await tinylytics.removeKudo('rsm-abc');
  assert.equal(sent[0].url, 'https://tinylytics.app/api/v1/sites/1525/kudos');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].body, { path: '/signs/exit-7', custom_uid: 'rsm-abc' });
  assert.equal(sent[0].headers.Authorization, `Bearer ${KEY}`);
  assert.match(sent[0].headers['User-Agent'], /roadsignmath\.xyz/);
  assert.equal(sent[1].url, 'https://tinylytics.app/api/v1/sites/1525/kudos/rsm-abc');
  assert.equal(sent[1].method, 'DELETE');
});

test('an ignored kudo, a server error or no answer is unavailable, and never shows the key', async () => {
  for (const answer of [{ status: 202 }, { status: 500 }, { status: 401 }, new Error(`socket closed ${KEY}`)]) {
    const { tinylytics } = client(() => answer);
    await assert.rejects(tinylytics.addKudo('/signs/x', 'u'), (err: unknown) => {
      assert.ok(err instanceof TinylyticsUnavailable);
      assert.equal(err.off, false);
      assert.ok(!err.message.includes(KEY), err.message);
      return true;
    });
  }
});

test('without a key every call is off, and the key is looked for again later', async () => {
  const { tinylytics, sent, keyReads, now } = client(() => ({ status: 200 }), null);
  await assert.rejects(tinylytics.kudos(), (err: unknown) => err instanceof TinylyticsUnavailable && err.off);
  await assert.rejects(tinylytics.addHits([{ path: '/' }]));
  assert.equal(sent.length, 0);
  assert.equal(keyReads(), 1);
  now.ms += 6 * 60_000;
  await assert.rejects(tinylytics.kudos());
  assert.equal(keyReads(), 2);
});

test('a key Tinylytics refuses is read again on the next call', async () => {
  const { tinylytics, keyReads } = client(() => ({ status: 401 }));
  await assert.rejects(tinylytics.removeKudo('u'));
  await assert.rejects(tinylytics.removeKudo('u'));
  assert.equal(keyReads(), 2);
});

test('kudos are read since the start, page by page, at most 700 days a read', async () => {
  const { tinylytics, sent } = client((s) => {
    const page = Number(new URL(s.url).searchParams.get('page'));
    return {
      status: 200,
      json: {
        kudos: page === 1 ? [{ uid: 'a', path: '/signs/x', id: 1 }] : [{ uid: 'b', path: '/signs/y' }, { bad: true }],
        pagination: { current_page: page, total_pages: 2 }
      }
    };
  });
  assert.deepEqual(await tinylytics.kudos('/signs/x'), [
    { uid: 'a', path: '/signs/x' },
    { uid: 'b', path: '/signs/y' }
  ]);
  const query = new URL(sent[0].url).searchParams;
  assert.equal(query.get('start_date'), '2026-10-01');
  assert.equal(query.get('end_date'), '2026-11-02');
  assert.equal(query.get('per_page'), '1000');
  assert.equal(query.get('path'), '/signs/x');
  assert.equal(sent.length, 2);

  assert.deepEqual(kudoWindows('2026-10-01', '2026-10-01'), [['2026-10-01', '2026-10-01']]);
  assert.deepEqual(kudoWindows('2026-10-01', '2028-10-01'), [
    ['2026-10-01', '2028-08-30'],
    ['2028-08-31', '2028-10-01']
  ]);
});

test('app views go as one batch marked as the app’s', async () => {
  const { tinylytics, sent } = client(() => ({ status: 200, json: { created_count: 2 } }));
  await tinylytics.addHits([{ path: '/', userAgent: 'RoadSignMath/1.0', country: 'US' }, { path: '/map' }]);
  assert.equal(sent[0].url, 'https://tinylytics.app/api/v1/sites/1525/hits/batch');
  assert.deepEqual(sent[0].body, [
    { path: '/', source: 'ios-app', user_agent: 'RoadSignMath/1.0', country: 'US' },
    { path: '/map', source: 'ios-app' }
  ]);
});

test('a key that is slow to read counts against the call’s deadline', async () => {
  const sent: string[] = [];
  const tinylytics = new KeyedTinylytics(
    () => new Promise((resolve) => setTimeout(() => resolve(KEY), 200)),
    async (url) => {
      sent.push(url);
      return new Response(null, { status: 200 });
    },
    1525
  );
  const started = Date.now();
  await assert.rejects(tinylytics.addHits([{ path: '/' }], 20), TinylyticsUnavailable);
  assert.ok(Date.now() - started < 150);
  assert.equal(sent.length, 0);
});
