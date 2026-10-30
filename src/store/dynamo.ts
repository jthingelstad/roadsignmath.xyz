// The live table: one DynamoDB table, string keys `pk` and `sk`, no indexes. Every key prefix is
// listed here, and test/docs.test.ts checks this list against the code and AGENTS.md.
//
//   pk                  sk                          holds
//   SIGNS               SIGN#<signId>               a sign (every sign is in one partition)
//   SIGN#<signId>       WAY#<createdAt>#<wayId>     a way to make that sign true
//   PLAYERS             PLAYER#<playerId>           a player
//   EMAIL#<sha256>      EMAIL                       the player id for an email address
//
// Items carry their fields at the top level next to pk, sk and `kind`.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import type { Player, Sign, Way } from '../domain/types.ts';
import { emailHash, type Store } from './store.ts';

export const KEY_PREFIXES = ['SIGNS', 'SIGN#', 'WAY#', 'PLAYERS', 'PLAYER#', 'EMAIL#', 'EMAIL'] as const;

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
    for (const w of ways) {
      await this.client.send(new DeleteCommand({ TableName: this.table, Key: { pk: w.pk, sk: w.sk } }));
    }
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'SIGNS', sk: `SIGN#${id}` } }));
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
    if (player.email) await this.put(`EMAIL#${emailHash(player.email)}`, 'EMAIL', 'email', { playerId: player.id });
  }

  async playerIdForEmail(email: string): Promise<string | undefined> {
    const item = await this.get(`EMAIL#${emailHash(email)}`, 'EMAIL');
    return item?.playerId as string | undefined;
  }
}
