// A tiny in-memory DynamoDB that understands the requests DynamoStore makes, and records them so
// tests can check their shape. Anything it doesn't understand throws, so a new kind of request
// needs a matching change here.

type Item = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Record<string, unknown> };

export class FakeDynamo {
  readonly table: string;
  readonly sent: { command: string; input: Record<string, unknown> }[] = [];
  private items = new Map<string, Item>();

  constructor(table = 'test-table') {
    this.table = table;
  }

  private key(pk: unknown, sk: unknown): string {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  /** Evaluates the few condition shapes DynamoStore writes: terms joined by all-AND or all-OR. */
  private holds(item: Item | undefined, condition: unknown, input: Record<string, unknown>): boolean {
    if (condition === undefined) return true;
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const text = String(condition);
    const joiner = text.includes(' OR ') ? ' OR ' : ' AND ';
    const results = text.split(joiner).map((term) => {
      const exists = /^attribute_(not_)?exists\((\w+)\)$/.exec(term);
      if (exists) return Boolean(exists[1]) !== (item !== undefined && item[exists[2]] !== undefined);
      const compare = /^(#?\w+) (=|<=|>=|<|>) (:\w+)$/.exec(term);
      if (!compare) throw new Error(`unknown condition ${term}`);
      if (!item) return false;
      const left = item[names[compare[1]] ?? compare[1]] as number | string;
      const right = values[compare[3]] as number | string;
      switch (compare[2]) {
        case '=':
          return left === right;
        case '<=':
          return left <= right;
        case '>=':
          return left >= right;
        case '<':
          return left < right;
        default:
          return left > right;
      }
    });
    return joiner === ' OR ' ? results.some(Boolean) : results.every(Boolean);
  }

  private fail(): never {
    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  }

  /** Applies `SET a = :x, b = if_not_exists(b,:y)`, `ADD a :x` and `REMOVE a` clauses, and returns what changed. */
  private update(item: Item, expression: string, input: Record<string, unknown>): Item {
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const changed: Item = {};
    for (const [, verb, body] of expression.matchAll(/(SET|ADD|REMOVE) (.*?)(?= SET | ADD | REMOVE |$)/g)) {
      for (const part of body.split(', ')) {
        const [path, ...rest] = part.split(' ');
        const field = names[path] ?? path;
        if (verb === 'REMOVE') delete item[field];
        else if (verb === 'ADD') item[field] = ((item[field] as number | undefined) ?? 0) + (values[rest[0]] as number);
        else if (rest[0] === '=' && rest[1].startsWith('if_not_exists(')) {
          const [, own, value] = /^if_not_exists\((#?\w+),(:\w+)\)$/.exec(rest[1]) ?? [];
          if (own === undefined) throw new Error(`unknown update ${part}`);
          item[field] = item[names[own] ?? own] ?? values[value];
        } else if (rest[0] === '=') item[field] = values[rest[1]];
        else throw new Error(`unknown update ${part}`);
        if (verb !== 'REMOVE') changed[field] = item[field];
      }
    }
    return changed;
  }

  async send(command: object): Promise<Record<string, unknown>> {
    const { constructor, input } = command as Command;
    const name = constructor.name;
    this.sent.push({ command: name, input: structuredClone(input) });
    if (name !== 'TransactWriteCommand' && input.TableName !== this.table) {
      throw new Error(`wrong table ${String(input.TableName)}`);
    }
    switch (name) {
      case 'PutCommand': {
        const item = input.Item as Item;
        if (typeof item.pk !== 'string' || typeof item.sk !== 'string') throw new Error('Put without string keys');
        for (const [k, v] of Object.entries(item)) if (v === undefined) throw new Error(`undefined attribute ${k}`);
        const k = this.key(item.pk, item.sk);
        if (!this.holds(this.items.get(k), input.ConditionExpression, input)) this.fail();
        this.items.set(k, structuredClone(item));
        return {};
      }
      case 'GetCommand': {
        const key = input.Key as Item;
        const item = this.items.get(this.key(key.pk, key.sk));
        return item ? { Item: structuredClone(item) } : {};
      }
      case 'UpdateCommand': {
        const key = input.Key as Item;
        const k = this.key(key.pk, key.sk);
        const current = this.items.get(k);
        if (!this.holds(current, input.ConditionExpression, input)) this.fail();
        const item = current ?? { pk: key.pk, sk: key.sk };
        const changed = this.update(item, String(input.UpdateExpression), input);
        this.items.set(k, item);
        return { Attributes: changed };
      }
      case 'DeleteCommand': {
        const key = input.Key as Item;
        const k = this.key(key.pk, key.sk);
        if (!this.holds(this.items.get(k), input.ConditionExpression, input)) this.fail();
        this.items.delete(k);
        return {};
      }
      case 'QueryCommand': {
        const expr = input.KeyConditionExpression as string;
        const values = input.ExpressionAttributeValues as Record<string, string>;
        let match: (item: Item) => boolean;
        if (expr === 'pk = :pk') match = (i) => i.pk === values[':pk'];
        else if (expr === 'pk = :pk AND begins_with(sk, :sk)') {
          match = (i) => i.pk === values[':pk'] && String(i.sk).startsWith(values[':sk']);
        } else throw new Error(`unknown key condition ${expr}`);
        const found = [...this.items.values()]
          .filter(match)
          .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : 1))
          .map((i) => structuredClone(i));
        if (input.ScanIndexForward === false) found.reverse();
        return { Items: found };
      }
      case 'TransactWriteCommand': {
        // Every condition is checked before anything is written, as DynamoDB does.
        const items = input.TransactItems as Record<string, Record<string, unknown>>[];
        const steps = items.map((entry) => {
          const [verb, request] = Object.entries(entry)[0];
          if (request.TableName !== this.table) throw new Error(`wrong table ${String(request.TableName)}`);
          const key = (verb === 'Put' ? request.Item : request.Key) as Item;
          return { verb, request, k: this.key(key.pk, key.sk), key };
        });
        const reasons = steps.map(({ request, k }) => ({
          Code: this.holds(this.items.get(k), request.ConditionExpression, request) ? 'None' : 'ConditionalCheckFailed'
        }));
        if (reasons.some((r) => r.Code !== 'None')) {
          throw Object.assign(new Error('Transaction cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: reasons
          });
        }
        for (const { verb, request, k, key } of steps) {
          if (verb === 'Put') this.items.set(k, structuredClone(request.Item as Item));
          else if (verb === 'Delete') this.items.delete(k);
          else if (verb === 'Update') {
            const item = this.items.get(k) ?? { pk: key.pk, sk: key.sk };
            this.update(item, String(request.UpdateExpression), request);
            this.items.set(k, item);
          } else throw new Error(`FakeDynamo does not handle ${verb} in a transaction`);
        }
        return {};
      }
      default:
        throw new Error(`FakeDynamo does not handle ${name}`);
    }
  }
}
