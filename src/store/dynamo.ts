// The live table: one DynamoDB table, string keys `pk` and `sk`, no indexes. Every key prefix is
// listed here, and test/docs.test.ts checks this list against the code and AGENTS.md.
//
//   pk                  sk                          holds
//   SIGNS               SIGN#<signId>               a sign (every sign is in one partition)
//   SIGN#<signId>       WAY#<createdAt>#<wayId>     a way to make that sign true
//   PLAYERS             PLAYER#<playerId>           a player
//   EMAIL#<sha256>      EMAIL                       the player id for an email address
//   HANDLE#<handle>     HANDLE                      the player id holding a handle
//   PLAYER#<playerId>   SESSION#<sha256>            a signed-in app (expires)
//   LOGIN#<loginId>     LOGIN                       a sign-in in progress (expires)
//   LIMIT#<key>         <windowStart>               a rate-limit count (expires)
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
  UpdateCommand,
  type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import type { Login, Player, Session, Sign, Way } from '../domain/types.ts';
import { emailHash, nowSeconds, type PlayerChanges, type Store } from './store.ts';

export const KEY_PREFIXES = [
  'SIGNS',
  'SIGN#',
  'WAY#',
  'PLAYERS',
  'PLAYER#',
  'EMAIL#',
  'EMAIL',
  'HANDLE#',
  'HANDLE',
  'SESSION#',
  'LOGIN#',
  'LOGIN',
  'LIMIT#'
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

  private async get(pk: string, sk: string): Promise<Item | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
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

  async getSign(id: string): Promise<Sign | undefined> {
    const item = await this.get('SIGNS', `SIGN#${id}`);
    return item && strip<Sign>(item);
  }

  async putSign(sign: Sign): Promise<void> {
    await this.put('SIGNS', `SIGN#${sign.id}`, 'sign', sign);
  }

  async deleteSign(id: string): Promise<void> {
    const ways = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `SIGN#${id}`, ':sk': 'WAY#' }
    });
    for (const w of ways) await this.delete(w.pk as string, w.sk as string);
    await this.delete('SIGNS', `SIGN#${id}`);
  }

  async listWays(signId: string): Promise<Way[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `SIGN#${signId}`, ':sk': 'WAY#' }
    });
    return items.map((i) => strip<Way>(i));
  }

  async putWay(way: Way): Promise<void> {
    await this.put(`SIGN#${way.signId}`, `WAY#${way.createdAt}#${way.id}`, 'way', way);
  }

  async deleteWay(way: Way): Promise<void> {
    await this.delete(`SIGN#${way.signId}`, `WAY#${way.createdAt}#${way.id}`);
  }

  async allPlayers(): Promise<Player[]> {
    const items = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': 'PLAYERS', ':sk': 'PLAYER#' }
    });
    return items.map((i) => strip<Player>(i));
  }

  async getPlayer(id: string): Promise<Player | undefined> {
    const item = await this.get('PLAYERS', `PLAYER#${id}`);
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

  /** Points an index row at the player unless another player holds it; returns its holder. */
  private async claim(pk: string, sk: string, kind: string, playerId: string): Promise<string> {
    const won = await this.when(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, kind, playerId },
        ConditionExpression: 'attribute_not_exists(pk) OR playerId = :id',
        ExpressionAttributeValues: { ':id': playerId }
      })
    );
    return won ? playerId : ((await this.get(pk, sk))?.playerId as string);
  }

  /** Deletes an index row only while it still points at the player. */
  private async unclaim(pk: string, sk: string, playerId: string): Promise<void> {
    await this.when(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk, sk },
        ConditionExpression: 'playerId = :id',
        ExpressionAttributeValues: { ':id': playerId }
      })
    );
  }

  async claimEmail(email: string, playerId: string): Promise<string> {
    return this.claim(`EMAIL#${emailHash(email)}`, 'EMAIL', 'email', playerId);
  }

  async claimHandle(handle: string, playerId: string): Promise<boolean> {
    return (await this.claim(`HANDLE#${handle}`, 'HANDLE', 'handle', playerId)) === playerId;
  }

  async releaseHandle(handle: string, playerId: string): Promise<void> {
    await this.unclaim(`HANDLE#${handle}`, 'HANDLE', playerId);
  }

  async playerIdForEmail(email: string): Promise<string | undefined> {
    const item = await this.get(`EMAIL#${emailHash(email)}`, 'EMAIL');
    return item?.playerId as string | undefined;
  }

  async deletePlayer(id: string): Promise<void> {
    const player = await this.getPlayer(id);
    const sessions = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${id}`, ':sk': 'SESSION#' }
    });
    for (const s of sessions) await this.delete(s.pk as string, s.sk as string);
    if (player?.email) await this.unclaim(`EMAIL#${emailHash(player.email)}`, 'EMAIL', id);
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
}
