import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KEY_PREFIXES } from '../src/store/dynamo.ts';

test('AGENTS.md lists every key in the table, and only those', async () => {
  const guide = await readFile('AGENTS.md', 'utf8');
  const code = await readFile('src/store/dynamo.ts', 'utf8');
  const rows = [...guide.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
  const header = [...code.matchAll(/^\/\/ {3}(\S+) +(\S+) {2,}/gm)]
    .map((m) => `${m[1]} ${m[2]}`)
    .filter((row) => row !== 'pk sk');
  assert.ok(rows.length >= 4, 'the table in AGENTS.md');
  assert.deepEqual(rows, header);
  const used = new Set(
    rows
      .flatMap((r) => r.split(' '))
      .map((k) => k.replace(/<[^>]+>/g, '').replace(/#.*$/, '#'))
      .filter(Boolean)
  );
  assert.deepEqual([...used].sort(), [...KEY_PREFIXES].sort());
});
