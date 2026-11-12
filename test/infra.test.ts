// The web function's role allows every DynamoDB action the store sends. A missing one passes
// every other test (the fake table checks no permissions) and fails only live: on 2026-11-12 a
// co-find's condition check was refused, and Quiz answered "Something broke".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/store/dynamo.ts', import.meta.url), 'utf8');

/** What each command, or each kind of item in a transaction, needs. */
const NEEDS: Record<string, string> = {
  GetCommand: 'dynamodb:GetItem',
  PutCommand: 'dynamodb:PutItem',
  UpdateCommand: 'dynamodb:UpdateItem',
  DeleteCommand: 'dynamodb:DeleteItem',
  QueryCommand: 'dynamodb:Query',
  ScanCommand: 'dynamodb:Scan',
  BatchGetCommand: 'dynamodb:BatchGetItem',
  BatchWriteCommand: 'dynamodb:BatchWriteItem',
  'ConditionCheck:': 'dynamodb:ConditionCheckItem',
  'Put:': 'dynamodb:PutItem',
  'Update:': 'dynamodb:UpdateItem',
  'Delete:': 'dynamodb:DeleteItem'
};

test('the web role allows every DynamoDB action src/store/dynamo.ts uses', () => {
  const allowed = new Set(template.match(/dynamodb:[A-Za-z]+/g));
  const used = Object.keys(NEEDS).filter((k) =>
    k.endsWith(':') ? new RegExp(`\\b${k}\\s*\\{`).test(store) : new RegExp(`new ${k}\\(`).test(store)
  );
  assert.ok(used.includes('ConditionCheck:') && used.includes('QueryCommand'), 'the store was read');
  for (const k of used) assert.ok(allowed.has(NEEDS[k]!), `${k} needs ${NEEDS[k]} in infra/template.yaml`);
  // Transactions need nothing of their own beyond each item's action.
  assert.ok(!allowed.has('dynamodb:Scan'), 'no scans');
});
