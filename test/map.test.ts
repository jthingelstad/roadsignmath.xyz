import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, GATHER, project } from '../src/web/map.ts';
import { US_MAP_SIZE } from '../src/web/us-map.ts';
import { sign } from './support/fixtures.ts';

// Signs strung along a line a little closer than GATHER, so a greedy pass leaves clusters whose
// middles drift together; the second pass must join them.
const signs = Array.from({ length: 24 }, (_, i) =>
  sign({
    id: `01JS00000000000000000000${String(i).padStart(2, '0')}`,
    title: `Sign ${i}`,
    place: { label: `Town ${i}`, state: 'MN', lat: 44 + i * 0.12, lng: -94 + i * 0.1, approximate: true }
  })
);

test('no two pins on the map are closer than GATHER, and every pinned sign is in one', () => {
  const { clusters, unpinned } = cluster(signs);
  assert.equal(unpinned.length, 0);
  assert.equal(
    clusters.reduce((n, c) => n + c.signs.length, 0),
    signs.length
  );
  const at = (c: { x: number; y: number }) => [(c.x / 100) * US_MAP_SIZE.width, (c.y / 100) * US_MAP_SIZE.height];
  for (let i = 0; i < clusters.length; i++)
    for (let j = i + 1; j < clusters.length; j++) {
      const [ax, ay] = at(clusters[i]);
      const [bx, by] = at(clusters[j]);
      assert.ok(Math.hypot(ax - bx, ay - by) > GATHER, `${clusters[i].key} and ${clusters[j].key}`);
    }
  // Each cluster keeps its signs newest first, as given.
  for (const c of clusters) {
    const order = c.signs.map((s) => signs.indexOf(s));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b)
    );
    assert.equal(c.key, c.signs[0].slug);
  }
  assert.ok(project(44, -94));
});
