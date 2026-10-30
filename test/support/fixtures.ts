// Fictional players and signs for tests. Real people and real signs stay out of tests.

import type { Player, Sign, Way } from '../../src/domain/types.ts';

export const ada: Player = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  handle: 'ada',
  name: 'Ada',
  avatarColor: '#006348',
  bio: 'Counts everything.',
  email: 'ada@example.com',
  createdAt: '2026-01-01T00:00:00.000Z'
};

export const ben: Player = {
  id: '01JBBBBBBBBBBBBBBBBBBBBBBB',
  handle: 'ben',
  name: 'Ben',
  avatarColor: '#004C80',
  createdAt: '2026-01-02T00:00:00.000Z'
};

export function sign(overrides: Partial<Sign> & { id: string; title: string }): Sign {
  return {
    slug: overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    photos: [{ id: `ph-${overrides.id}`, width: 1600, height: 1200, alt: `Photo of the ${overrides.title} sign` }],
    numbers: [
      { value: '7', text: '7' },
      { value: '12', text: '12' },
      { value: '19', text: '19' }
    ],
    place: { label: 'Testville, Minnesota', state: 'MN', lat: 44.98, lng: -93.27, approximate: true },
    foundOn: '2026-01-10',
    postedAt: '2026-01-10T12:00:00.000Z',
    postedBy: ada.id,
    finders: [{ playerId: ada.id, name: ada.name, role: 'found' }],
    visibility: 'shown',
    firstWay: { text: '7 + 12 = 19', value: '19', playerId: ada.id },
    wayCount: 1,
    ...overrides
  };
}

export function way(signId: string, overrides: Partial<Way> = {}): Way {
  return {
    id: `way-${signId}`,
    signId,
    playerId: ada.id,
    text: '7 + 12 = 19',
    value: '19',
    numbers: ['7', '12', '19'],
    createdAt: '2026-01-10T12:00:00.000Z',
    ...overrides
  };
}
