import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { API_VERSION } from '../src/api/contract.ts';
import { openApi, surfaceDigest } from '../src/api/openapi.ts';

test('contracts/api-surface.json is up to date (npm run contract)', async () => {
  const saved = JSON.parse(await readFile('contracts/api-surface.json', 'utf8'));
  assert.deepEqual(saved, openApi());
});

test('this API_VERSION is recorded with this surface', async () => {
  const versions = JSON.parse(await readFile('contracts/api-versions.json', 'utf8')) as Record<string, string>;
  assert.equal(versions[API_VERSION], surfaceDigest());
});

test('every schema the document points at exists', () => {
  const doc = openApi() as { components: { schemas: Record<string, unknown> } };
  const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
  for (const name of new Set(refs)) assert.ok(doc.components.schemas[name], name);
});
