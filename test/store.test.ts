import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { DynamoStore } from '../src/store/dynamo.ts';
import { nowSeconds, type Store } from '../src/store/store.ts';
import { FakeDynamo } from './support/fake-dynamo.ts';
import { ada, ben, sign, way } from './support/fixtures.ts';

const kinds: [string, () => Store][] = [
  ['MemoryStore', () => new MemoryStore()],
  ['DynamoStore', () => new DynamoStore('test-table', new FakeDynamo('test-table'))]
];

for (const [name, make] of kinds) {
  describe(name, () => {
    test('signs round-trip and list', async () => {
      const store = make();
      const a = sign({ id: 'S1', title: 'One' });
      await store.putSign(a);
      await store.putSign(sign({ id: 'S2', title: 'Two' }));
      assert.deepEqual(await store.getSign('S1'), a);
      assert.equal((await store.allSigns()).length, 2);
      assert.equal(await store.getSign('nope'), undefined);
    });

    test('ways list oldest first, and go with their sign', async () => {
      const store = make();
      await store.putSign(sign({ id: 'S1', title: 'One' }));
      await store.putWay(way('S1', { id: 'w2', createdAt: '2026-02-02T00:00:00.000Z' }));
      await store.putWay(way('S1', { id: 'w1', createdAt: '2026-02-01T00:00:00.000Z' }));
      assert.deepEqual(
        (await store.listWays('S1')).map((w) => w.id),
        ['w1', 'w2']
      );
      await store.deleteSign('S1');
      assert.equal(await store.getSign('S1'), undefined);
      assert.deepEqual(await store.listWays('S1'), []);
    });

    test('players and email lookup', async () => {
      const store = make();
      await store.putPlayer(ada);
      await store.putPlayer(ben);
      assert.deepEqual(await store.getPlayer(ada.id), ada);
      assert.equal((await store.allPlayers()).length, 2);
      assert.equal(await store.playerIdForEmail('  ADA@example.com '), ada.id);
      assert.equal(await store.playerIdForEmail('ben@example.com'), undefined);
      await store.deletePlayer(ada.id);
      assert.equal(await store.getPlayer(ada.id), undefined);
      assert.equal(await store.playerIdForEmail('ada@example.com'), undefined);
      assert.ok(await store.getPlayer(ben.id));
    });

    test('a way can be deleted on its own', async () => {
      const store = make();
      const first = way('S1', { id: 'w1', createdAt: '2026-02-01T00:00:00.000Z' });
      await store.putWay(first);
      await store.putWay(way('S1', { id: 'w2', createdAt: '2026-02-02T00:00:00.000Z' }));
      await store.deleteWay(first);
      assert.deepEqual(
        (await store.listWays('S1')).map((w) => w.id),
        ['w2']
      );
    });

    test('logins and sessions read back until they expire', async () => {
      const store = make();
      const now = nowSeconds();
      const login = {
        id: 'L1',
        email: 'ada@example.com',
        tokenHash: 't',
        codeHash: 'c',
        attempts: 0,
        createdAt: '2026-02-01T00:00:00.000Z',
        expiresAt: now + 60
      };
      await store.putLogin(login);
      assert.deepEqual(await store.getLogin('L1'), login);
      await store.putLogin({ ...login, id: 'L2', expiresAt: now - 1 });
      assert.equal(await store.getLogin('L2'), undefined);
      await store.deleteLogin('L1');
      assert.equal(await store.getLogin('L1'), undefined);

      const session = {
        playerId: ada.id,
        secretHash: 'h',
        createdAt: login.createdAt,
        lastUsedAt: login.createdAt,
        expiresAt: now + 60
      };
      await store.putSession(session);
      assert.deepEqual(await store.getSession(ada.id, 'h'), session);
      assert.equal(await store.getSession(ada.id, 'other'), undefined);
      await store.putSession({ ...session, secretHash: 'old', expiresAt: now - 1 });
      assert.equal(await store.getSession(ada.id, 'old'), undefined);
      await store.deleteSession(ada.id, 'h');
      assert.equal(await store.getSession(ada.id, 'h'), undefined);
    });

    test('bump counts within a window and starts again in the next', async () => {
      const store = make();
      const start = Math.floor(nowSeconds() / 3600) * 3600;
      assert.equal(await store.bump('k', 3600, start + 1), 1);
      assert.equal(await store.bump('k', 3600, start + 2), 2);
      assert.equal(await store.bump('other', 3600, start + 2), 1);
      assert.equal(await store.bump('k', 3600, start + 3601), 1);
    });
  });
}

test('DynamoStore keys follow the documented layout', async () => {
  const fake = new FakeDynamo('test-table');
  const store = new DynamoStore('test-table', fake);
  await store.putSign(sign({ id: 'S1', title: 'One' }));
  await store.putWay(way('S1', { id: 'w1' }));
  await store.putPlayer(ada);
  const puts = fake.sent.filter((s) => s.command === 'PutCommand').map((s) => s.input.Item as Record<string, string>);
  assert.deepEqual(
    puts.map((i) => [i.pk, i.sk.replace(/[0-9a-f]{64}/, '<hash>'), i.kind]),
    [
      ['SIGNS', 'SIGN#S1', 'sign'],
      ['SIGN#S1', 'WAY#2026-01-10T12:00:00.000Z#w1', 'way'],
      ['PLAYERS', `PLAYER#${ada.id}`, 'player'],
      [puts[3].pk, 'EMAIL', 'email']
    ]
  );
  assert.match(puts[3].pk, /^EMAIL#[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(puts[3]).includes('ada@example.com'), 'the email index holds a hash, not the address');
});
