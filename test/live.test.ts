import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import { httpEndpoint } from '../src/listen.ts';
import { liveConfig, liveOptions } from '../src/live.ts';
import { SesMailer } from '../src/mail/mailer.ts';
import {
  KeyedModerator,
  ModeratorUnavailable,
  type Moderator,
  type Post,
  type PostVerdict
} from '../src/moderation/moderator.ts';
import { S3PhotoStore } from '../src/photos.ts';
import { secretField } from '../src/secrets.ts';
import { DynamoStore } from '../src/store/dynamo.ts';

// Made up: the stack's environment for a fictional deploy. Nothing here reaches the network.
const env = {
  TABLE: 'example-table',
  PHOTO_BUCKET: 'example-photos',
  PHOTO_DISTRIBUTION_ID: 'EEXAMPLE123',
  FROM_ADDRESS: 'Road Sign Math <signin@example.test>',
  SITE_URL: 'https://example.test',
  RUNTIME_SECRET: 'example-runtime'
};

test('the live server is wired from the stack environment', () => {
  const config = liveConfig(env);
  assert.deepEqual(config, {
    table: 'example-table',
    photoBucket: 'example-photos',
    photoDistributionId: 'EEXAMPLE123',
    fromAddress: 'Road Sign Math <signin@example.test>',
    site: 'https://example.test',
    runtimeSecret: 'example-runtime'
  });
  const options = liveOptions(config);
  assert.ok(options.store instanceof DynamoStore);
  assert.ok(options.photos instanceof S3PhotoStore);
  assert.ok(options.mailer instanceof SesMailer);
  assert.ok(options.moderator instanceof KeyedModerator);
  assert.deepEqual(options.urls, { site: 'https://example.test' });
  assert.ok(createApp(options));
});

test('the first deploy has no distribution yet, and a missing setting stops the server', () => {
  assert.equal(liveConfig({ ...env, PHOTO_DISTRIBUTION_ID: '' }).photoDistributionId, undefined);
  assert.equal(liveConfig({ ...env, PHOTO_DISTRIBUTION_ID: undefined }).photoDistributionId, undefined);
  for (const name of ['TABLE', 'PHOTO_BUCKET', 'FROM_ADDRESS', 'SITE_URL', 'RUNTIME_SECRET'])
    assert.throws(() => liveConfig({ ...env, [name]: ' ' }), new RegExp(`${name} is not set`));
  assert.throws(() => liveConfig({ ...env, SITE_URL: 'http://example.test' }), /https origin/);
  assert.throws(() => liveConfig({ ...env, SITE_URL: 'https://example.test/' }), /https origin/);
});

test("the app's Apple team comes from the stack, when it has one", () => {
  assert.equal(liveConfig(env).appleTeamId, undefined);
  assert.equal(liveConfig({ ...env, APPLE_TEAM_ID: '' }).appleTeamId, undefined);
  const config = liveConfig({ ...env, APPLE_TEAM_ID: 'ABCDE12345' });
  assert.equal(config.appleTeamId, 'ABCDE12345');
  assert.equal(liveOptions(config).appleTeamId, 'ABCDE12345');
  assert.throws(() => liveConfig({ ...env, APPLE_TEAM_ID: 'abcde12345' }), /Team ID/);
  assert.throws(() => liveConfig({ ...env, APPLE_TEAM_ID: 'ABCDE123456' }), /Team ID/);
});

test('the server listens where the platform says', () => {
  assert.deepEqual(httpEndpoint('127.0.0.1:8080'), { hostname: '127.0.0.1', port: 8080 });
  assert.deepEqual(httpEndpoint('[::1]:9000'), { hostname: '::1', port: 9000 });
  assert.deepEqual(httpEndpoint('0.0.0.0:443'), { hostname: '0.0.0.0', port: 443 });
  for (const bad of ['8080', 'host:', 'host:0', 'host:70000', ':80', '[::1]'])
    assert.throws(() => httpEndpoint(bad), /Invalid HTTP/);
});

const post: Post = { title: 'Exit 7', numbers: ['7'], photos: [] };
const verdict: PostVerdict = { verdict: 'ok', reason: '', alt: [] };
const fixed: Moderator = {
  reviewPost: async () => verdict,
  reviewReport: async () => ({ verdict: 'keep', reason: '' })
};

test('without a key the moderator is unavailable, and asks again next time', async () => {
  const keys: (string | undefined)[] = [undefined, 'example-key'];
  let reads = 0;
  const made: string[] = [];
  const moderator = new KeyedModerator(
    async () => keys[reads++],
    (key) => {
      made.push(key);
      return fixed;
    }
  );
  await assert.rejects(moderator.reviewPost(post), ModeratorUnavailable);
  assert.deepEqual(await moderator.reviewPost(post), verdict);
  assert.deepEqual(await moderator.reviewReport(post, 'spam'), { verdict: 'keep', reason: '' });
  assert.equal(reads, 2, 'the key is kept once found');
  assert.deepEqual(made, ['example-key']);
});

test('a failed key read is unavailable, logs only its name, and is tried again', async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (entry: unknown) => logged.push(entry));
  let reads = 0;
  const moderator = new KeyedModerator(
    async () => {
      if (reads++ === 0) {
        const error = new Error('secret text that must not be logged');
        error.name = 'ThrottlingException';
        throw error;
      }
      return 'example-key';
    },
    () => fixed
  );
  await assert.rejects(moderator.reviewPost(post), ModeratorUnavailable);
  assert.deepEqual(logged, [{ event: 'moderator-key', outcome: 'ThrottlingException' }]);
  assert.deepEqual(await moderator.reviewPost(post), verdict);
});

function secrets(answer: string | undefined | Error) {
  const asked: unknown[] = [];
  return {
    asked,
    client: {
      send: async (command: { input: unknown }) => {
        asked.push(command.input);
        if (answer instanceof Error) throw answer;
        return { SecretString: answer };
      }
    } as never
  };
}

test('the runtime secret gives one field, or nothing', async () => {
  const { asked, client } = secrets('{"ANTHROPIC_API_KEY":" example-key ","OTHER":1}');
  assert.equal(await secretField('example-runtime', 'ANTHROPIC_API_KEY', client), 'example-key');
  assert.deepEqual(asked, [{ SecretId: 'example-runtime' }]);
  assert.equal(await secretField('s', 'OTHER', client), undefined);
  assert.equal(await secretField('s', 'MISSING', client), undefined);
  assert.equal(await secretField('s', 'ANTHROPIC_API_KEY', secrets('{"ANTHROPIC_API_KEY":""}').client), undefined);
  assert.equal(await secretField('s', 'ANTHROPIC_API_KEY', secrets(undefined).client), undefined);
  assert.equal(await secretField('s', 'ANTHROPIC_API_KEY', secrets('null').client), undefined);
  const missing = new Error('no such secret');
  missing.name = 'ResourceNotFoundException';
  assert.equal(await secretField('s', 'ANTHROPIC_API_KEY', secrets(missing).client), undefined);
});

test('a secret that is not JSON fails without quoting it', async () => {
  await assert.rejects(secretField('s', 'K', secrets('example-key-not-json').client), (error: Error) => {
    assert.equal(error.message, 'The runtime secret is not JSON');
    return true;
  });
  const denied = new Error('denied');
  denied.name = 'AccessDeniedException';
  await assert.rejects(secretField('s', 'K', secrets(denied).client), { name: 'AccessDeniedException' });
});
