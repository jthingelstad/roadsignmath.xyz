import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { DynamoStore } from '../src/store/dynamo.ts';
import { addPlayer, addSign, nowSeconds, type Store } from '../src/store/store.ts';
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

    test('a slug is freed only by the sign holding it', async () => {
      const store = make();
      assert.equal(await store.claimSlug('exit-7', 'S1'), true);
      await store.releaseSlug('exit-7', 'S2');
      assert.equal(await store.claimSlug('exit-7', 'S2'), false);
      await store.releaseSlug('exit-7', 'S1');
      assert.equal(await store.claimSlug('exit-7', 'S2'), true);
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
      await addPlayer(store, ada);
      await addPlayer(store, ben);
      assert.deepEqual(await store.getPlayer(ada.id), ada);
      assert.equal((await store.allPlayers()).length, 2);
      assert.equal(await store.playerIdForEmail('  ADA@example.com '), ada.id);
      assert.equal(await store.playerIdForEmail('ben@example.com'), undefined);
      await store.deletePlayer(ada.id);
      assert.equal(await store.getPlayer(ada.id), undefined);
      assert.equal(await store.playerIdForEmail('ada@example.com'), undefined);
      assert.ok(await store.getPlayer(ben.id));
    });

    test('an email and a handle belong to the first player to claim them', async () => {
      const store = make();
      assert.equal(await store.claimEmail('Same@example.com', 'P1'), 'P1');
      assert.equal(await store.claimEmail('same@example.com', 'P2'), 'P1');
      assert.equal(await store.claimEmail('same@example.com', 'P1'), 'P1');
      assert.equal(await store.claimHandle('ada', 'P1'), true);
      assert.equal(await store.claimHandle('ada', 'P2'), false);
      await store.releaseHandle('ada', 'P2');
      assert.equal(await store.claimHandle('ada', 'P2'), false, 'only the holder can free a handle');
      await store.releaseHandle('ada', 'P1');
      assert.equal(await store.claimHandle('ada', 'P2'), true);
    });

    test("deleting a player frees their email and handle, and no one else's", async () => {
      const store = make();
      await addPlayer(store, ada);
      await store.putPlayer({ ...ben, email: ada.email, handle: 'loser' });
      await store.deletePlayer(ben.id);
      assert.equal(await store.playerIdForEmail(ada.email!), ada.id);
      assert.equal(await store.claimHandle(ada.handle, ben.id), false);
      await store.deletePlayer(ada.id);
      assert.equal(await store.playerIdForEmail(ada.email!), undefined);
      assert.equal(await store.claimHandle(ada.handle, ben.id), true);
    });

    test('updatePlayer changes fields in place, and only an unnamed player when asked', async () => {
      const store = make();
      await addPlayer(store, { ...ben, name: '', bio: 'Old.' });
      assert.equal(await store.updatePlayer(ben.id, { name: 'Ben', handle: 'ben-2' }, true), true);
      assert.equal(await store.updatePlayer(ben.id, { name: 'Benjamin', handle: 'nope' }, true), false);
      assert.equal(await store.updatePlayer(ben.id, { bio: null }), true);
      const after = (await store.getPlayer(ben.id))!;
      assert.equal(after.name, 'Ben');
      assert.equal(after.handle, 'ben-2');
      assert.equal(after.bio, undefined);
      assert.equal(after.email, ben.email);
      assert.equal(await store.updatePlayer('nobody', { name: 'X' }), false);
    });

    test('a login is used once, and wrong codes count until it is gone', async () => {
      const store = make();
      const now = nowSeconds();
      const login = {
        id: 'L1',
        email: 'a@example.com',
        tokenHash: 't',
        codeHash: 'c',
        attempts: 0,
        createdAt: '2026-02-01T00:00:00.000Z',
        expiresAt: now + 60
      };
      await store.putLogin(login);
      assert.equal(await store.addLoginAttempt('L1'), 1);
      assert.equal(await store.addLoginAttempt('L1'), 2);
      const both = await Promise.all([store.consumeLogin('L1'), store.consumeLogin('L1')]);
      assert.deepEqual(both.sort(), [false, true]);
      assert.equal(await store.addLoginAttempt('L1'), undefined, 'a wrong code never brings a used login back');
      assert.equal(await store.getLogin('L1'), undefined);
      await store.putLogin({ ...login, id: 'L2', expiresAt: now - 1 });
      assert.equal(await store.consumeLogin('L2'), false);
      assert.equal(await store.addLoginAttempt('L2'), undefined);
    });

    test('updateSign changes only the fields given, and null removes one', async () => {
      const store = make();
      const a = sign({ id: 'S1', title: 'One' });
      await store.putSign(a);
      assert.equal(
        await store.updateSign('S1', { visibility: 'hidden', moderation: { note: 'No.', at: a.postedAt } }),
        true
      );
      assert.equal(await store.updateSign('S1', { wayCount: 0, firstWay: null }), true);
      const after = (await store.getSign('S1'))!;
      const expected = { ...a, visibility: 'hidden', moderation: { note: 'No.', at: a.postedAt }, wayCount: 0 };
      delete expected.firstWay;
      assert.deepEqual(after, expected);
      assert.equal('firstWay' in after, false);
      assert.equal(await store.updateSign('S1', { moderation: null }), true);
      assert.equal((await store.getSign('S1'))!.moderation, undefined);
      assert.equal(await store.updateSign('nope', { wayCount: 1 }), false);
    });

    test('a slug belongs to the first sign to claim it until that sign is deleted', async () => {
      const store = make();
      await addSign(store, sign({ id: 'S1', title: 'One' }));
      assert.equal(await store.claimSlug('one', 'S2'), false);
      assert.equal(await store.claimSlug('one', 'S1'), true);
      await store.deleteSign('S1');
      assert.equal(await store.claimSlug('one', 'S2'), true);
    });

    test('uploads, reports, blocks and post keys', async () => {
      const store = make();
      const now = nowSeconds();
      const upload = { playerId: ada.id, photoId: 'p1', width: 4, height: 3, createdAt: 'x', expiresAt: now + 60 };
      await store.putUpload(upload);
      await store.putUpload({ ...upload, photoId: 'old', expiresAt: now - 1 });
      assert.deepEqual(await store.getUpload(ada.id, 'p1'), upload);
      assert.equal(await store.getUpload(ada.id, 'old'), undefined);
      await store.deleteUpload(ada.id, 'p1');
      assert.equal(await store.getUpload(ada.id, 'p1'), undefined);

      const report = {
        signId: 'S1',
        playerId: ben.id,
        reason: 'Spam',
        outcome: 'kept' as const,
        note: 'Fine.',
        createdAt: 'x'
      };
      await store.putSign(sign({ id: 'S1', title: 'One' }));
      await store.putReport(report);
      assert.deepEqual(await store.getReport('S1', ben.id), report);
      await store.deleteSign('S1');
      assert.equal(await store.getReport('S1', ben.id), undefined, 'reports go with their sign');

      await store.putBlock({ playerId: ada.id, blockedId: ben.id, createdAt: 'x' });
      assert.deepEqual(
        (await store.listBlocks(ada.id)).map((b) => b.blockedId),
        [ben.id]
      );
      assert.deepEqual(await store.listBlocks(ben.id), []);
      await store.deleteBlock(ada.id, ben.id);
      assert.deepEqual(await store.listBlocks(ada.id), []);

      assert.equal(await store.claimPost(ada.id, 'key', 'S1', 60), undefined);
      assert.equal(await store.claimPost(ada.id, 'key', 'S2', 60), 'S1');
      assert.equal(await store.claimPost(ben.id, 'key', 'S3', 60), undefined, 'keys are per player');
      await store.releasePost(ada.id, 'key');
      assert.equal(await store.claimPost(ada.id, 'key', 'S4', 60), undefined);
      assert.equal(await store.claimPost(ada.id, 'gone', 'S5', -1), undefined);
      assert.equal(await store.claimPost(ada.id, 'gone', 'S6', 60), undefined, 'an expired key can be claimed again');
    });

    test('deleting a player clears what is kept under them', async () => {
      const store = make();
      await addPlayer(store, ada);
      const now = nowSeconds();
      await store.putUpload({
        playerId: ada.id,
        photoId: 'p1',
        width: 4,
        height: 3,
        createdAt: 'x',
        expiresAt: now + 60
      });
      await store.putBlock({ playerId: ada.id, blockedId: ben.id, createdAt: 'x' });
      await store.claimPost(ada.id, 'key', 'S1', 60);
      await store.deletePlayer(ada.id);
      assert.equal(await store.getUpload(ada.id, 'p1'), undefined);
      assert.deepEqual(await store.listBlocks(ada.id), []);
      assert.equal(await store.claimPost(ada.id, 'key', 'S2', 60), undefined);
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

    test('a way’s math is held by one way on its sign until that way goes', async () => {
      const store = make();
      const first = way('S1', { id: 'w1' });
      assert.equal(await store.claimWay('S1', first.text, 'w1'), true);
      assert.equal(await store.claimWay('S1', first.text, 'w1'), true, 'the same way again');
      assert.equal(await store.claimWay('S1', first.text, 'w2'), false);
      assert.equal(await store.claimWay('S2', first.text, 'w3'), true, 'another sign');
      await store.putWay(first);
      await store.deleteWay(first);
      assert.equal(await store.claimWay('S1', first.text, 'w2'), true);
      await store.putSign(sign({ id: 'S2', title: 'Two' }));
      await store.deleteSign('S2');
      assert.equal(await store.claimWay('S2', first.text, 'w4'), true, 'gone with its sign');
    });

    test('a way is added with its math, its count and the first way, or not at all', async () => {
      const store = make();
      await store.putSign(sign({ id: 'S1', title: 'One', wayCount: 0 }));
      const first = way('S1', { id: 'w1', playerId: ada.id, createdAt: '2026-02-01T00:00:00.000Z' });
      assert.equal(await store.addWay(first), 'added');
      assert.equal(await store.addWay({ ...first, id: 'w2' }), 'taken');
      const other = way('S1', {
        id: 'w3',
        playerId: ben.id,
        text: '19 − 12 = 7',
        value: '7',
        createdAt: '2026-02-02T00:00:00.000Z'
      });
      assert.equal(await store.addWay(other), 'added');
      const s = (await store.getSign('S1'))!;
      assert.equal(s.wayCount, 2);
      assert.deepEqual(s.firstWay, { text: first.text, value: first.value, playerId: ada.id });
      assert.deepEqual(
        (await store.listWays('S1')).map((w) => w.id),
        ['w1', 'w3']
      );
      assert.equal(await store.addWay(way('gone', { id: 'w4' })), 'gone');
      assert.equal(await store.getSign('gone'), undefined, 'a deleted sign isn’t made again');
      assert.deepEqual(await store.listWays('gone'), []);
      assert.equal(await store.claimWay('gone', first.text, 'w5'), true, 'nor its math held');
    });

    test('an upload is taken by one post, and given back if that post fails', async () => {
      const store = make();
      const upload = {
        playerId: ada.id,
        photoId: 'p1',
        width: 10,
        height: 10,
        createdAt: 'x',
        expiresAt: nowSeconds() + 60
      };
      await store.putUpload(upload);
      assert.equal(await store.claimUpload(ada.id, 'p1', 'S1'), true);
      assert.equal(await store.claimUpload(ada.id, 'p1', 'S2'), false);
      await store.releaseUpload(ada.id, 'p1', 'S2');
      assert.equal(await store.claimUpload(ada.id, 'p1', 'S2'), false, 'only its taker gives it back');
      await store.releaseUpload(ada.id, 'p1', 'S1');
      assert.equal(await store.claimUpload(ada.id, 'p1', 'S2'), true);
      assert.equal(await store.claimUpload(ada.id, 'p9', 'S1'), false, 'no such upload');
      await store.putUpload({ ...upload, photoId: 'old', expiresAt: nowSeconds() - 1 });
      assert.equal(await store.claimUpload(ada.id, 'old', 'S1'), false, 'expired');
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
  await addPlayer(store, ada);
  const puts = fake.sent.filter((s) => s.command === 'PutCommand').map((s) => s.input.Item as Record<string, string>);
  assert.deepEqual(
    puts.map((i) => [i.pk.replace(/[0-9a-f]{64}/, '<hash>'), i.sk, i.kind]),
    [
      ['SIGNS', 'SIGN#S1', 'sign'],
      ['SIGN#S1', 'WAY#2026-01-10T12:00:00.000Z#w1', 'way'],
      [`HANDLE#${ada.handle}`, 'HANDLE', 'handle'],
      ['EMAIL#<hash>', 'EMAIL', 'email'],
      ['PLAYERS', `PLAYER#${ada.id}`, 'player']
    ]
  );
  assert.ok(!JSON.stringify(puts[3]).includes('ada@example.com'), 'the email index holds a hash, not the address');
});

test('DynamoStore adds a way in one transaction of the documented shape', async () => {
  const fake = new FakeDynamo('test-table');
  const store = new DynamoStore('test-table', fake);
  await store.putSign(sign({ id: 'S1', title: 'One' }));
  await store.addWay(way('S1', { id: 'w1' }));
  const sent = fake.sent.at(-1)!;
  assert.equal(sent.command, 'TransactWriteCommand');
  const items = sent.input.TransactItems as Record<string, Record<string, unknown>>[];
  assert.deepEqual(
    items.map((i) => Object.keys(i)[0]),
    ['Put', 'Put', 'Update']
  );
  const [math, row, count] = items.map((i) => Object.values(i)[0]);
  assert.match(String((math.Item as Record<string, string>).sk), /^MATH#[0-9a-f]{64}$/);
  assert.equal(math.ConditionExpression, 'attribute_not_exists(pk) OR wayId = :id');
  assert.equal((row.Item as Record<string, string>).sk, 'WAY#2026-01-10T12:00:00.000Z#w1');
  assert.deepEqual(count.Key, { pk: 'SIGNS', sk: 'SIGN#S1' });
  assert.equal(count.UpdateExpression, 'ADD wayCount :one SET firstWay = if_not_exists(firstWay,:first)');
  assert.equal(count.ConditionExpression, 'attribute_exists(pk)');
  for (const i of items) assert.equal(Object.values(i)[0].TableName, 'test-table');
});
