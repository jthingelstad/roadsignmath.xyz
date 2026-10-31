// The live table: one DynamoDB table, string keys `pk` and `sk`, no indexes. Every key prefix is
// listed here, and test/docs.test.ts checks this list against the code and AGENTS.md.
//
//   pk                  sk                          holds
//   SIGNS               SIGN#<signId>               a sign (every sign is in one partition)
//   SIGN#<signId>       WAY#<createdAt>#<wayId>     a way to make that sign true
//   PLAYERS             PLAYER#<playerId>           a player
//   EMAIL#<sha256>      EMAIL                       the player id for an email address
//   HANDLE#<handle>     HANDLE                      the player id holding a handle
//   SLUG#<slug>         SLUG                        the sign id holding a slug
//   SIGN#<signId>       MATH#<sha256>               the way id holding that math on the sign
//   SIGN#<signId>       REPORT#<playerId>           a player's report of that sign
//   PLAYER#<playerId>   SESSION#<sha256>            a signed-in app (expires)
//   PLAYER#<playerId>   UPLOAD#<photoId>            a photo uploaded, not yet posted (expires)
//   PLAYER#<playerId>   BLOCK#<playerId>            a player they blocked
//   PLAYER#<playerId>   HEART#<signId>              a sign they hearted, and its kudo's uid
//   PLAYER#<playerId>   POST#<idempotencyKey>       the sign a post's key made (expires)
//   LOGIN#<loginId>     LOGIN                       a sign-in in progress (expires)
//   LIMIT#<key>         <windowStart>               a rate-limit count (expires)
//   LEASE#<key>         LEASE                       one request's hold on what the key names (expires)
//
// Items carry their fields at the top level next to pk, sk and `kind`. Items that expire carry
// `expiresAt` in epoch seconds, the table's time-to-live attribute; reads check it too, since
// the table removes expired items only eventually.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import type { Block, Heart, Login, Player, Report, Session, Sign, Upload, Way } from '../domain/types.ts';
import { emailHash, nowSeconds, wayHash, type PlayerChanges, type SignChanges, type Store } from './store.ts';

export const KEY_PREFIXES = [
  'SIGNS',
  'SIGN#',
  'WAY#',
  'MATH#',
  'PLAYERS',
  'PLAYER#',
  'EMAIL#',
  'EMAIL',
  'HANDLE#',
  'HANDLE',
  'SLUG#',
  'SLUG',
  'SESSION#',
  'REPORT#',
  'UPLOAD#',
  'BLOCK#',
  'HEART#',
  'POST#',
  'LOGIN#',
  'LOGIN',
  'LIMIT#',
  'LEASE#',
  'LEASE'
] as const;

/** The one method of the document client this store uses, so tests can pass a fake. */
export type DocClient = { send(command: object): Promise<Record<string, unknown>> };

type Item = Record<string, unknown>;

function strip<T>(item: Item): T {
  const rest = { ...item };
  delete rest.pk;
  delete rest.sk;
  delete rest.kind;
  return rest as T;
}

export class DynamoStore implements Store {
  private readonly client: DocClient;

  constructor(
    private readonly table: string,
    client?: DocClient
  ) {
    this.client =
      client ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true }
      }) as unknown as DocClient);
  }

  private async query(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({ TableName: this.table, ...input, ExclusiveStartKey: start })
      );
      items.push(...((out.Items as Item[] | undefined) ?? []));
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return items;
  }

  private async get(pk: string, sk: string, consistent = false): Promise<Item | undefined> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: consistent || undefined })
    );
    return out.Item as Item | undefined;
  }

  /** Runs a conditional write; false when its condition failed. */
  private async when(command: object): Promise<boolean> {
    try {
      await this.client.send(command);
      return true;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  private async put(pk: string, sk: string, kind: string, fields: object): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: { ...fields, pk, sk, kind } }));
  }

  async allSigns(): Promise<Sign[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': 'SIGNS', ':sk': 'SIGN#' }
    });
    return items.map((i) => strip<Sign>(i));
  }

  async getSign(id: string, consistent = false): Promise<Sign | undefined> {
    const item = await this.get('SIGNS', `SIGN#${id}`, consistent);
    return item && strip<Sign>(item);
  }

  async putSign(sign: Sign): Promise<void> {
    await this.put('SIGNS', `SIGN#${sign.id}`, 'sign', sign);
  }

  async updateSign(id: string, changes: SignChanges): Promise<boolean> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    const removes: string[] = [];
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      names[`#${field}`] = field;
      if (value === null) removes.push(`#${field}`);
      else {
        sets.push(`#${field} = :${field}`);
        values[`:${field}`] = value;
      }
    }
    if (!sets.length && !removes.length) return !!(await this.getSign(id));
    const update = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : '']
      .filter(Boolean)
      .join(' ');
    return this.when(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: 'SIGNS', sk: `SIGN#${id}` },
        UpdateExpression: update,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
      })
    );
  }

  async claimSlug(slug: string, signId: string): Promise<boolean> {
    return (await this.claim(`SLUG#${slug}`, 'SLUG', 'slug', 'signId', signId)) === signId;
  }

  async releaseSlug(slug: string, signId: string): Promise<void> {
    await this.unclaim(`SLUG#${slug}`, 'SLUG', 'signId', signId);
  }

  async deleteSign(id: string): Promise<void> {
    const sign = await this.getSign(id);
    await this.deletePartition(`SIGN#${id}`);
    if (sign) await this.unclaim(`SLUG#${sign.slug}`, 'SLUG', 'signId', id);
    await this.delete('SIGNS', `SIGN#${id}`);
  }

  /** Every row under one pk: a sign's ways and reports, or a player's sessions, uploads and the rest. */
  private async deletePartition(pk: string): Promise<void> {
    const items = await this.query({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk } });
    for (const item of items) await this.delete(item.pk as string, item.sk as string);
  }

  async listWays(signId: string): Promise<Way[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `SIGN#${signId}`, ':sk': 'WAY#' },
      // Read right after a way is added or removed, so it must see that write.
      ConsistentRead: true
    });
    return items.map((i) => strip<Way>(i));
  }

  async claimWay(signId: string, text: string, wayId: string): Promise<boolean> {
    return (await this.claim(`SIGN#${signId}`, `MATH#${wayHash(text)}`, 'math', 'wayId', wayId)) === wayId;
  }

  async putWay(way: Way): Promise<void> {
    await this.put(`SIGN#${way.signId}`, `WAY#${way.createdAt}#${way.id}`, 'way', way);
  }

  async deleteWay(way: Way): Promise<void> {
    await this.delete(`SIGN#${way.signId}`, `WAY#${way.createdAt}#${way.id}`);
    await this.unclaim(`SIGN#${way.signId}`, `MATH#${wayHash(way.text)}`, 'wayId', way.id);
  }

  async addWay(way: Way): Promise<'added' | 'taken' | 'gone'> {
    const first = { text: way.text, value: way.value, playerId: way.playerId };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: `SIGN#${way.signId}`, sk: `MATH#${wayHash(way.text)}`, kind: 'math', wayId: way.id },
                ConditionExpression: 'attribute_not_exists(pk) OR wayId = :id',
                ExpressionAttributeValues: { ':id': way.id }
              }
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...way, pk: `SIGN#${way.signId}`, sk: `WAY#${way.createdAt}#${way.id}`, kind: 'way' }
              }
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: 'SIGNS', sk: `SIGN#${way.signId}` },
                UpdateExpression: 'ADD wayCount :one SET firstWay = if_not_exists(firstWay,:first)',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeValues: { ':one': 1, ':first': first }
              }
            }
          ]
        })
      );
      return 'added';
    } catch (err) {
      if ((err as Error).name !== 'TransactionCanceledException') throw err;
      const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'taken';
      if (reasons[2]?.Code === 'ConditionalCheckFailed') return 'gone';
      throw err;
    }
  }

  async allPlayers(): Promise<Player[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': 'PLAYERS', ':sk': 'PLAYER#' }
    });
    return items.map((i) => strip<Player>(i));
  }

  async getPlayer(id: string, consistent = false): Promise<Player | undefined> {
    const item = await this.get('PLAYERS', `PLAYER#${id}`, consistent);
    return item && strip<Player>(item);
  }

  async putPlayer(player: Player): Promise<void> {
    await this.put('PLAYERS', `PLAYER#${player.id}`, 'player', player);
  }

  async updatePlayer(id: string, changes: PlayerChanges, onlyIfUnnamed = false): Promise<boolean> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    const removes: string[] = [];
    for (const field of ['name', 'handle', 'bio'] as const) {
      const value = changes[field];
      if (value === undefined) continue;
      names[`#${field}`] = field;
      if (value === null) removes.push(`#${field}`);
      else {
        sets.push(`#${field} = :${field}`);
        values[`:${field}`] = value;
      }
    }
    let condition = 'attribute_exists(pk)';
    if (onlyIfUnnamed) {
      condition = '#name = :unnamed';
      names['#name'] = 'name';
      values[':unnamed'] = '';
    }
    const update = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : '']
      .filter(Boolean)
      .join(' ');
    if (!update) {
      const player = await this.getPlayer(id);
      return !!player && !(onlyIfUnnamed && player.name);
    }
    return this.when(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: 'PLAYERS', sk: `PLAYER#${id}` },
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
      })
    );
  }

  async setAvatar(id: string, avatar: string | null): Promise<{ previous?: string } | false> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: 'PLAYERS', sk: `PLAYER#${id}` },
          UpdateExpression: avatar === null ? 'REMOVE avatar' : 'SET avatar = :avatar',
          ConditionExpression: 'attribute_exists(pk)',
          ...(avatar === null ? {} : { ExpressionAttributeValues: { ':avatar': avatar } }),
          ReturnValues: 'UPDATED_OLD'
        })
      );
      return { previous: (out.Attributes as Item | undefined)?.avatar as string | undefined };
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  /** Points an index row's `field` at `id` unless another holds it; returns its holder. */
  private async claim(pk: string, sk: string, kind: string, field: string, id: string): Promise<string> {
    const won = await this.when(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, kind, [field]: id },
        ConditionExpression: `attribute_not_exists(pk) OR ${field} = :id`,
        ExpressionAttributeValues: { ':id': id }
      })
    );
    return won ? id : ((await this.get(pk, sk))?.[field] as string);
  }

  /** Deletes an index row only while its `field` still points at `id`. */
  private async unclaim(pk: string, sk: string, field: string, id: string): Promise<void> {
    await this.when(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk, sk },
        ConditionExpression: `${field} = :id`,
        ExpressionAttributeValues: { ':id': id }
      })
    );
  }

  async claimEmail(email: string, playerId: string): Promise<string> {
    return this.claim(`EMAIL#${emailHash(email)}`, 'EMAIL', 'email', 'playerId', playerId);
  }

  async claimHandle(handle: string, playerId: string): Promise<boolean> {
    return (await this.claim(`HANDLE#${handle}`, 'HANDLE', 'handle', 'playerId', playerId)) === playerId;
  }

  async releaseHandle(handle: string, playerId: string): Promise<void> {
    await this.unclaim(`HANDLE#${handle}`, 'HANDLE', 'playerId', playerId);
  }

  async playerIdForEmail(email: string): Promise<string | undefined> {
    const item = await this.get(`EMAIL#${emailHash(email)}`, 'EMAIL');
    return item?.playerId as string | undefined;
  }

  async deletePlayer(id: string): Promise<void> {
    const player = await this.getPlayer(id);
    await this.deletePartition(`PLAYER#${id}`);
    if (player?.email) await this.unclaim(`EMAIL#${emailHash(player.email)}`, 'EMAIL', 'playerId', id);
    if (player) await this.releaseHandle(player.handle, id);
    await this.delete('PLAYERS', `PLAYER#${id}`);
  }

  private async delete(pk: string, sk: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }

  private live<T>(item: Item | undefined): T | undefined {
    return item && (item.expiresAt as number) > nowSeconds() ? strip<T>(item) : undefined;
  }

  async putLogin(login: Login): Promise<void> {
    await this.put(`LOGIN#${login.id}`, 'LOGIN', 'login', login);
  }

  async getLogin(id: string): Promise<Login | undefined> {
    return this.live<Login>(await this.get(`LOGIN#${id}`, 'LOGIN'));
  }

  async deleteLogin(id: string): Promise<void> {
    await this.delete(`LOGIN#${id}`, 'LOGIN');
  }

  async addLoginAttempt(id: string): Promise<number | undefined> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `LOGIN#${id}`, sk: 'LOGIN' },
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now',
          ExpressionAttributeValues: { ':one': 1, ':now': nowSeconds() },
          ReturnValues: 'UPDATED_NEW'
        })
      );
      return (out.Attributes as { attempts: number }).attempts;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return undefined;
      throw err;
    }
  }

  async consumeLogin(id: string): Promise<boolean> {
    return this.when(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: `LOGIN#${id}`, sk: 'LOGIN' },
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now',
        ExpressionAttributeValues: { ':now': nowSeconds() }
      })
    );
  }

  async putSession(session: Session): Promise<void> {
    await this.put(`PLAYER#${session.playerId}`, `SESSION#${session.secretHash}`, 'session', session);
  }

  async getSession(playerId: string, secretHash: string): Promise<Session | undefined> {
    return this.live<Session>(await this.get(`PLAYER#${playerId}`, `SESSION#${secretHash}`));
  }

  async deleteSession(playerId: string, secretHash: string): Promise<void> {
    await this.delete(`PLAYER#${playerId}`, `SESSION#${secretHash}`);
  }

  async bump(key: string, seconds: number, now: number): Promise<number> {
    const start = now - (now % seconds);
    const out = await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `LIMIT#${key}`, sk: String(start) },
        UpdateExpression: 'ADD #count :one SET expiresAt = :expires, kind = :kind',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: { ':one': 1, ':expires': start + seconds, ':kind': 'limit' },
        ReturnValues: 'UPDATED_NEW'
      })
    );
    return (out.Attributes as { count: number }).count;
  }

  async putUpload(upload: Upload): Promise<void> {
    await this.put(`PLAYER#${upload.playerId}`, `UPLOAD#${upload.photoId}`, 'upload', upload);
  }

  async getUpload(playerId: string, photoId: string): Promise<Upload | undefined> {
    return this.live<Upload>(await this.get(`PLAYER#${playerId}`, `UPLOAD#${photoId}`));
  }

  async claimUpload(playerId: string, photoId: string, signId: string): Promise<boolean> {
    return this.when(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `PLAYER#${playerId}`, sk: `UPLOAD#${photoId}` },
        UpdateExpression: 'SET signId = :id',
        ConditionExpression: 'expiresAt > :now AND attribute_not_exists(signId)',
        ExpressionAttributeValues: { ':id': signId, ':now': nowSeconds() }
      })
    );
  }

  async releaseUpload(playerId: string, photoId: string, signId: string): Promise<void> {
    await this.when(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `PLAYER#${playerId}`, sk: `UPLOAD#${photoId}` },
        UpdateExpression: 'REMOVE signId',
        ConditionExpression: 'signId = :id',
        ExpressionAttributeValues: { ':id': signId }
      })
    );
  }

  async deleteUpload(playerId: string, photoId: string): Promise<void> {
    await this.delete(`PLAYER#${playerId}`, `UPLOAD#${photoId}`);
  }

  async putReport(report: Report): Promise<void> {
    await this.put(`SIGN#${report.signId}`, `REPORT#${report.playerId}`, 'report', report);
  }

  async getReport(signId: string, playerId: string): Promise<Report | undefined> {
    const item = await this.get(`SIGN#${signId}`, `REPORT#${playerId}`);
    return item && strip<Report>(item);
  }

  async deleteReport(signId: string, playerId: string): Promise<void> {
    await this.delete(`SIGN#${signId}`, `REPORT#${playerId}`);
  }

  async putBlock(block: Block): Promise<void> {
    await this.put(`PLAYER#${block.playerId}`, `BLOCK#${block.blockedId}`, 'block', block);
  }

  async deleteBlock(playerId: string, blockedId: string): Promise<void> {
    await this.delete(`PLAYER#${playerId}`, `BLOCK#${blockedId}`);
  }

  async listBlocks(playerId: string): Promise<Block[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'BLOCK#' }
    });
    return items.map((i) => strip<Block>(i));
  }

  async putHeart(heart: Heart): Promise<void> {
    await this.put(`PLAYER#${heart.playerId}`, `HEART#${heart.signId}`, 'heart', heart);
  }

  async getHeart(playerId: string, signId: string): Promise<Heart | undefined> {
    // Read to decide whether a heart changes, often right after the last change: it must see it.
    const item = await this.get(`PLAYER#${playerId}`, `HEART#${signId}`, true);
    return item && strip<Heart>(item);
  }

  async deleteHeart(playerId: string, signId: string): Promise<void> {
    await this.delete(`PLAYER#${playerId}`, `HEART#${signId}`);
  }

  async listHearts(playerId: string): Promise<Heart[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'HEART#' },
      // Read to show a heart the player just gave, and to take them all back on account delete.
      ConsistentRead: true
    });
    return items.map((i) => strip<Heart>(i));
  }

  async claimPost(playerId: string, key: string, signId: string, seconds: number): Promise<string | undefined> {
    const now = nowSeconds();
    const pk = `PLAYER#${playerId}`;
    const sk = `POST#${key}`;
    const claimed = await this.when(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, kind: 'post', signId, expiresAt: now + seconds },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': now }
      })
    );
    if (claimed) return undefined;
    // Expired between the put and the read: say the key is busy rather than claim it twice.
    return this.live<{ signId: string }>(await this.get(pk, sk))?.signId ?? signId;
  }

  async releasePost(playerId: string, key: string): Promise<void> {
    await this.delete(`PLAYER#${playerId}`, `POST#${key}`);
  }
  async lease(key: string, holder: string, seconds: number): Promise<boolean> {
    const now = nowSeconds();
    return this.when(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `LEASE#${key}`, sk: 'LEASE', kind: 'lease', holder, expiresAt: now + seconds },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now OR holder = :holder',
        ExpressionAttributeValues: { ':now': now, ':holder': holder }
      })
    );
  }

  async endLease(key: string, holder: string): Promise<void> {
    await this.when(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: `LEASE#${key}`, sk: 'LEASE' },
        ConditionExpression: 'holder = :holder',
        ExpressionAttributeValues: { ':holder': holder }
      })
    );
  }
}
