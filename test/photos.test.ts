import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3PhotoStore } from '../src/photos.ts';

/** An S3 that has every file but refuses to delete one, as DeleteObjects does: with a 200. */
function stubbornS3() {
  const sent: string[] = [];
  return {
    sent,
    async send(command: { constructor: { name: string } }) {
      sent.push(command.constructor.name);
      if (command.constructor.name === 'DeleteObjectsCommand') {
        return { Errors: [{ Key: 'p/x/large.jpg', Code: 'AccessDenied' }] };
      }
      return {};
    }
  };
}

test('S3 photos fail when S3 keeps a file it was asked to delete', async () => {
  const store = new S3PhotoStore('bucket');
  const s3 = stubbornS3();
  (store as unknown as { client: unknown }).client = s3;
  await assert.rejects(store.remove('x'), /S3 kept 1 of 4 photo files \(AccessDenied\)/);
  await assert.rejects(store.hide('x'), /S3 kept 1 of 2 photo files/);
  assert.ok(s3.sent.includes('CopyObjectCommand'), 'hide copied before it deleted');
});
