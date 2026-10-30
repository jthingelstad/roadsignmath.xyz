// Write the `/api/v1` description to contracts/api-surface.json and record this version's digest
// in contracts/api-versions.json. A changed surface under a version already recorded is refused:
// clients read `api_version` to know what they may call. Run with `npm run contract`.

import { readFile, writeFile } from 'node:fs/promises';
import { API_VERSION } from '../src/api/contract.ts';
import { openApi, surfaceDigest } from '../src/api/openapi.ts';

const surface = 'contracts/api-surface.json';
const ledger = 'contracts/api-versions.json';

const versions = JSON.parse(await readFile(ledger, 'utf8').catch(() => '{}')) as Record<string, string>;
const digest = surfaceDigest();
if (versions[API_VERSION] && versions[API_VERSION] !== digest) {
  console.error(`The API changed under ${API_VERSION}: give API_VERSION a new version in src/api/contract.ts.`);
  process.exit(1);
}
versions[API_VERSION] = digest;
await writeFile(surface, JSON.stringify(openApi(), null, 2) + '\n', 'utf8');
await writeFile(ledger, JSON.stringify(versions, null, 2) + '\n', 'utf8');
console.log(`${surface} written for ${API_VERSION}`);
