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

  async send(command: object): Promise<Record<string, unknown>> {
    const { constructor, input } = command as Command;
    const name = constructor.name;
    this.sent.push({ command: name, input: structuredClone(input) });
    if (input.TableName !== this.table) throw new Error(`wrong table ${String(input.TableName)}`);
    switch (name) {
      case 'PutCommand': {
        const item = input.Item as Item;
        if (typeof item.pk !== 'string' || typeof item.sk !== 'string') throw new Error('Put without string keys');
        for (const [k, v] of Object.entries(item)) if (v === undefined) throw new Error(`undefined attribute ${k}`);
        this.items.set(this.key(item.pk, item.sk), structuredClone(item));
        return {};
      }
      case 'GetCommand': {
        const key = input.Key as Item;
        const item = this.items.get(this.key(key.pk, key.sk));
        return item ? { Item: structuredClone(item) } : {};
      }
      case 'UpdateCommand': {
        // Only the rate-limit counter's update.
        if (input.UpdateExpression !== 'ADD #count :one SET expiresAt = :expires, kind = :kind') {
          throw new Error(`unknown update ${String(input.UpdateExpression)}`);
        }
        const key = input.Key as Item;
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const k = this.key(key.pk, key.sk);
        const item = this.items.get(k) ?? { pk: key.pk, sk: key.sk, count: 0 };
        item.count = (item.count as number) + (values[':one'] as number);
        item.expiresAt = values[':expires'];
        item.kind = values[':kind'];
        this.items.set(k, item);
        return { Attributes: { count: item.count, expiresAt: item.expiresAt, kind: item.kind } };
      }
      case 'DeleteCommand': {
        const key = input.Key as Item;
        this.items.delete(this.key(key.pk, key.sk));
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
      default:
        throw new Error(`FakeDynamo does not handle ${name}`);
    }
  }
}
