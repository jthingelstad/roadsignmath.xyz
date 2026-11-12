// The owner's commands, from the Mac, when a report comes in (src/owner.ts says what each does):
//
//   npm run owner -- hide-sign <slug> --to check         read only: what hiding it would change
//   npm run owner -- hide-sign <slug> --to live          hide it (a live write: the owner's)
//   npm run owner -- hide-sign <slug> --to live --note "…"   with the note its poster sees
//   npm run owner -- unhide-sign <slug> --to check|live  show a hidden or held sign again
//   npm run owner -- set-place <slug> --lat=41.575 --lng=-87.26 [--label "…"] [--state IN] [--approximate] --to check|live
//                                                       put a sign on the map (a label or state left out stays)
//   npm run owner -- remove-way <slug> --to check        read only: the sign's ways and their ids
//   npm run owner -- remove-way <slug> --way <id> --to check|live   take one way off the sign
//   npm run owner -- remove-player <handle> --to check   read only: what removing them would delete
//   TINYLYTICS_API_KEY=… BUTTONDOWN_API_KEY=… npm run owner -- remove-player <handle> --to live
//
// It reads the table, photo bucket and distribution from the roadsignmath-xyz stack as the
// cloud-engineer profile. `remove-player --to live` is DELETE /me for that player: it needs the
// Tinylytics key (their hearts' kudos go first) and the Buttondown key (their address leaves the
// newsletter) through the environment (`op run`), never on the command line. Every live run clears
// the edge once at the end. An email address is never printed.

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ApiError } from '../src/api/errors.ts';
import { CloudFrontEdgeCache } from '../src/edge-cache.ts';
import { Buttondown } from '../src/newsletter.ts';
import { OWNER_COMMANDS, OwnerRefused, runOwner, type OwnerCommand } from '../src/owner.ts';
import { S3PhotoStore } from '../src/photos.ts';
import { DynamoStore } from '../src/store/dynamo.ts';
import { KeyedTinylytics } from '../src/tinylytics.ts';

const USAGE = [
  'Usage: npm run owner -- hide-sign <slug> --to check|live [--note "…"]',
  '       npm run owner -- unhide-sign <slug> --to check|live',
  '       npm run owner -- set-place <slug> --lat=<n> --lng=<n> [--label "…"] [--state XX] [--approximate] --to check|live',
  '       npm run owner -- remove-way <slug> [--way <id>] --to check|live',
  '       npm run owner -- remove-player <handle> --to check|live'
].join('\n');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string' },
    note: { type: 'string' },
    way: { type: 'string' },
    lat: { type: 'string' },
    lng: { type: 'string' },
    label: { type: 'string' },
    state: { type: 'string' },
    approximate: { type: 'boolean' }
  }
});
const [command, target] = positionals;
if (
  !OWNER_COMMANDS.includes(command as OwnerCommand) ||
  !target ||
  positionals.length !== 2 ||
  (values.to !== 'check' && values.to !== 'live')
) {
  console.error(USAGE);
  process.exit(64);
}

/** One output of the live stack, read with the AWS CLI so no name is written down here. */
function output(key: string): string {
  const query = `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--stack-name', 'roadsignmath-xyz', '--query', query];
  const value = execFileSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' }).trim();
  if (!value || value === 'None') throw new Error(`The roadsignmath-xyz stack has no ${key}`);
  return value;
}

process.env.AWS_PROFILE ??= 'cloud-engineer';
process.env.AWS_REGION ??= 'us-east-1';
const live = values.to === 'live';
const distribution = output('DistributionId');
const tinylyticsKey = process.env.TINYLYTICS_API_KEY?.trim();
const buttondownKey = process.env.BUTTONDOWN_API_KEY?.trim();

try {
  const lines = await runOwner(
    {
      store: new DynamoStore(output('TableName')),
      photos: new S3PhotoStore(output('PhotoBucketName'), distribution),
      edgeCache: live ? new CloudFrontEdgeCache(distribution) : undefined,
      ...(tinylyticsKey ? { tinylytics: new KeyedTinylytics(async () => tinylyticsKey) } : {}),
      ...(buttondownKey ? { newsletter: new Buttondown(async () => buttondownKey) } : {})
    },
    command as OwnerCommand,
    target,
    live ? 'live' : 'check',
    {
      note: values.note,
      way: values.way,
      place: {
        lat: values.lat === undefined ? undefined : Number(values.lat),
        lng: values.lng === undefined ? undefined : Number(values.lng),
        label: values.label,
        state: values.state,
        approximate: values.approximate
      }
    }
  );
  for (const line of lines) console.log(line);
} catch (err) {
  if (err instanceof OwnerRefused || err instanceof ApiError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
