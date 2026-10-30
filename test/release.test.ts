import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFor, readManifest } from '../tools/native-artifacts.ts';
import { packageBundle, packageRelease } from '../tools/package-native.ts';
import { main } from '../tools/release-cli.ts';
import { allowedCaller, stackInAccount } from '../tools/release-identity.ts';
import { probe } from '../tools/release-probe.ts';
import { canonical, endpointPolicy, servedRevision, type Context } from '../tools/web-platform.ts';

// Made-up identifiers throughout: account 000000000000 is no one's.
const account = '000000000000';
const commit = 'a'.repeat(40);
const functionArn = `arn:aws:lambda:us-east-1:${account}:web-function/roadsignmath-xyz-web`;
const endpointArn = `${functionArn}/endpoint/live`;

test('only the cloud-engineer role, or the deploy role inside Actions, may release', () => {
  const engineer = `arn:aws:sts::${account}:assumed-role/ProjectsCloudEngineer/projects-cloud-engineer`;
  const deploy = `arn:aws:sts::${account}:assumed-role/RoadSignMathGitHubDeploy/run-1`;
  assert.equal(allowedCaller(engineer, false), true);
  assert.equal(allowedCaller(engineer, true), true);
  assert.equal(allowedCaller(deploy, true), true);
  assert.equal(allowedCaller(deploy, false), false);
  assert.equal(allowedCaller(`arn:aws:iam::${account}:user/someone`, true), false);
  assert.equal(allowedCaller(undefined, true), false);
});

test('a stack counts only in the caller account', () => {
  const id = `arn:aws:cloudformation:us-east-1:${account}:stack/roadsignmath-xyz/abc`;
  assert.equal(stackInAccount(id, 'roadsignmath-xyz', account), true);
  assert.equal(stackInAccount(id, 'roadsignmath-xyz', '111111111111'), false);
  assert.equal(stackInAccount(id, 'roadsignmath-xyz-deploy', account), false);
  assert.equal(stackInAccount(undefined, 'roadsignmath-xyz', account), false);
});

test('the endpoint grant is CloudFront, from one distribution, to the live endpoint only', () => {
  const distribution = `arn:aws:cloudfront::${account}:distribution/EEXAMPLE`;
  const policy = endpointPolicy(endpointArn, distribution);
  assert.deepEqual(policy.Statement, [
    {
      Sid: 'RoadSignMathCloudFrontLiveOnly',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 'lambda:InvokeWebFunctionEndpoint',
      Resource: endpointArn,
      Condition: { StringEquals: { 'aws:SourceArn': distribution } }
    }
  ]);
  // The same policy with its keys in another order compares equal.
  const [statement] = policy.Statement;
  const reordered = {
    Statement: [Object.fromEntries(Object.entries(statement!).reverse())],
    Version: policy.Version
  };
  assert.equal(canonical(reordered), canonical(policy));
  assert.notEqual(canonical({ ...policy, Version: '2008-10-17' }), canonical(policy));
  assert.throws(() => canonical({ a: undefined }), /Undefined policy field/);
});

const endpoint = {
  authType: 'IamAuth',
  endpointType: 'HomeRegion',
  autoDeploymentMode: 'Disabled',
  state: 'Active',
  updateStatus: 'Successful',
  throttleConfig: { rateLimit: 100 },
  revisionWeights: [{ revisionId: 'rev-2', weight: 100 }],
  functionArn,
  endpointArn,
  endpointName: 'live',
  domainName: 'live.example.test'
} as const;

test('live must be private, regional and serve one revision', () => {
  assert.equal(servedRevision(endpoint as never), 'rev-2');
  for (const change of [
    { authType: 'None' },
    { endpointType: 'Global' },
    { autoDeploymentMode: 'Enabled' },
    { state: 'Updating' },
    { updateStatus: 'Failed' },
    { throttleConfig: { rateLimit: 5000 } },
    {
      revisionWeights: [
        { revisionId: 'rev-1', weight: 90 },
        { revisionId: 'rev-2', weight: 10 }
      ]
    },
    { revisionWeights: [{ weight: 100 }] }
  ])
    assert.throws(() => servedRevision({ ...endpoint, ...change } as never), /Endpoint must be/);
});

function context(revision: { state: string; description: string }, outputs: Record<string, string> = {}) {
  const asked: string[] = [];
  const ctx: Context = {
    account,
    distributionArn: `arn:aws:cloudfront::${account}:distribution/EEXAMPLE`,
    outputs: {
      WebFunctionName: 'roadsignmath-xyz-web',
      WebFunctionArn: functionArn,
      WebLiveEndpointArn: endpointArn,
      WebLiveEndpointDomain: 'live.example.test',
      WebLiveRevisionId: 'rev-2',
      DistributionDomain: 'd111111abcdef8.cloudfront.net',
      ...outputs
    },
    web: {
      send: async (command: { constructor: { name: string } }) => {
        asked.push(command.constructor.name);
        return command.constructor.name === 'GetWebFunctionEndpointCommand' ? endpoint : revision;
      }
    } as never
  };
  return { ctx, asked };
}

const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body });
const noPause = async () => undefined;

test('the probe checks the live revision is this build and reads the API index', async () => {
  const urls: string[] = [];
  const { ctx, asked } = context({ state: 'Active', description: commit });
  const result = await probe(commit, {
    ctx,
    fetch: async (url) => {
      urls.push(url);
      return { status: 200, json: async () => ({ api_version: '1.0.0' }) } as never;
    },
    pause: noPause
  });
  assert.deepEqual(result, { endpoint: 'live', index: 'ok' });
  assert.deepEqual(asked, ['GetWebFunctionEndpointCommand', 'GetWebFunctionRevisionCommand']);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /^https:\/\/d111111abcdef8\.cloudfront\.net\/api\/v1\?probe=\d+$/);
});

test('the probe fails on another build, another revision, or no answer', async () => {
  const ok = answer(200, { api_version: '1.0.0' });
  await assert.rejects(
    probe(commit, { ctx: context({ state: 'Active', description: 'b'.repeat(40) }).ctx, fetch: ok, pause: noPause }),
    /not an active one of this build/
  );
  await assert.rejects(
    probe(commit, { ctx: context({ state: 'Inactive', description: commit }).ctx, fetch: ok, pause: noPause }),
    /not an active one of this build/
  );
  await assert.rejects(
    probe(commit, {
      ctx: context({ state: 'Active', description: commit }, { WebLiveRevisionId: 'rev-1' }).ctx,
      fetch: ok,
      pause: noPause
    }),
    /not the revision this release built/
  );
  let tries = 0;
  await assert.rejects(
    probe(commit, {
      ctx: context({ state: 'Active', description: commit }).ctx,
      fetch: async () => {
        tries++;
        return { status: 503, json: async () => ({}) } as never;
      },
      pause: noPause
    }),
    /did not answer through CloudFront/
  );
  assert.equal(tries, 5);
  await assert.rejects(
    probe(commit, {
      ctx: context({ state: 'Active', description: commit }, { DistributionDomain: 'roadsignmath.example' }).ctx,
      fetch: ok,
      pause: noPause
    }),
    /Unexpected distribution domain/
  );
  await assert.rejects(probe('main'), /committed build/);
});

test('the code zip is the same bytes every time, with Sharp under node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsm-package-'));
  try {
    await mkdir(join(root, 'dist/server'), { recursive: true });
    await writeFile(join(root, 'dist/server/index.js'), 'console.log("server");\n');
    const modules = join(root, 'native');
    for (const name of [
      'sharp',
      '@img/colour',
      '@img/sharp-linux-arm64',
      '@img/sharp-libvips-linux-arm64',
      'detect-libc',
      'semver'
    ]) {
      await mkdir(join(modules, name, 'lib'), { recursive: true });
      await writeFile(join(modules, name, 'package.json'), `{"name":"${name}"}\n`);
      await writeFile(join(modules, name, 'lib/index.js'), '\n');
    }
    const first = await packageRelease(root, modules, join(root, 'one'));
    const second = await packageRelease(root, modules, join(root, 'two'));
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(join(root, 'one/app.zip')), await readFile(join(root, 'two/app.zip')));
    const [artifact] = await readManifest(join(root, 'one'));
    assert.equal(keyFor(artifact!), `native/app/${artifact!.sha256}.zip`);
    const zip = (await readFile(join(root, 'one/app.zip'))).toString('latin1');
    for (const path of [
      'index.js',
      'package.json',
      'node_modules/sharp/package.json',
      'node_modules/@img/sharp-linux-arm64/lib/index.js'
    ])
      assert.ok(zip.includes(path), path);

    await symlink(join(modules, 'semver'), join(modules, 'sharp/lib/linked'));
    await assert.rejects(packageBundle(join(root, 'dist/server'), join(root, 'linked.zip'), modules), /symlink/);
    await rm(join(modules, 'semver'), { recursive: true });
    await assert.rejects(
      packageBundle(join(root, 'dist/server'), join(root, 'missing.zip'), modules),
      /missing or linked/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the release tool takes only what each command needs', async () => {
  const major = process.versions.node.split('.')[0];
  if (major !== '24') return;
  await assert.rejects(main(['deploy']), /Unknown release command/);
  await assert.rejects(main(['upload', '--artifacts', 'relative', '--commit', commit]), /absolute path/);
  await assert.rejects(main(['upload', '--artifacts', '/tmp', '--commit', 'main']), /committed build/);
  await assert.rejects(main(['upload', '--artifacts', '/tmp', '--extra', 'x']), /Invalid release option/);
  await assert.rejects(main(['policies', '--force']), /Invalid release option/);
  await assert.rejects(main(['probe', '--commit', 'main']), /committed build/);
});
