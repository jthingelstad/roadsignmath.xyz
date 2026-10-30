import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid, ulidFrom } from '../src/domain/ids.ts';

test('ids made in the same millisecond sort in the order they were made', () => {
  const at = Date.UTC(2026, 9, 30, 12);
  const ids = Array.from({ length: 50 }, () => ulid(at));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
  const earlier = ulid(at - 5000);
  assert.ok(earlier > ids.at(-1)!, 'a clock that went back still counts up');
});

test('ulidFrom is the same for the same time and key, whatever was made before', () => {
  const at = Date.UTC(2023, 0, 1);
  const first = ulidFrom(at, 'seed');
  ulid(Date.now());
  assert.equal(ulidFrom(at, 'seed'), first);
  assert.equal(first.slice(0, 10), ulidFrom(at, 'other').slice(0, 10));
});
