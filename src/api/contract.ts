// The `/api/v1` surface in one place: the version, the routes, the limits and the error codes.
// The app registers a handler for each route by its operation id, and src/api/openapi.ts
// describes the same table, so the contract can't drift from the code.

/**
 * Bump on every change to the surface. tools/export-api-contract.ts refuses a changed surface
 * under a version already in contracts/api-versions.json.
 */
export const API_VERSION = '1.0.0';

export const LIMITS = {
  /** Signs per page of the feed. */
  pageDefault: 20,
  pageMax: 50,
  /** Signs in a "Near you" answer. */
  nearMax: 50,
  /** How far "Nobody has posted this sign yet" looks, in miles. */
  similarMiles: 2,
  /** Numbers a similar-sign question may send. */
  similarNumbersMax: 30
} as const;

export const ERRORS = {
  bad_request: 'A parameter is missing or out of range; the message says which.',
  not_found: 'No such route, sign or player.',
  internal: 'Something broke on the server.'
} as const;

export type ErrorCode = keyof typeof ERRORS;

export type Param = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
};

export type Route = {
  operationId: string;
  method: 'get';
  /** OpenAPI form, under /api/v1: "/signs/{id}". */
  path: string;
  summary: string;
  description: string;
  params: Param[];
  /** A schema name in openapi.ts. */
  response: string;
};

const lat: Param = {
  name: 'lat',
  in: 'query',
  required: true,
  description: 'Latitude in degrees.',
  schema: { type: 'number', minimum: -90, maximum: 90 }
};
const lng: Param = {
  name: 'lng',
  in: 'query',
  required: true,
  description: 'Longitude in degrees.',
  schema: { type: 'number', minimum: -180, maximum: 180 }
};

export const ROUTES: Route[] = [
  {
    operationId: 'getIndex',
    method: 'get',
    path: '',
    summary: 'The API version and how many signs, players and states there are',
    description: 'Read `api_version` to know what this server can do.',
    params: [],
    response: 'Index'
  },
  {
    operationId: 'getOpenApi',
    method: 'get',
    path: '/openapi.json',
    summary: 'This description',
    description: 'OpenAPI 3.1, the same document as contracts/api-surface.json in the repo.',
    params: [],
    response: 'OpenApi'
  },
  {
    operationId: 'listSigns',
    method: 'get',
    path: '/signs',
    summary: 'The latest signs, newest first',
    description:
      `A page of at most \`limit\` signs (default ${LIMITS.pageDefault}, at most ${LIMITS.pageMax}). ` +
      'Pass `next_cursor` back as `cursor` for the next page; it is null on the last.',
    params: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `next_cursor` from the page before.',
        schema: { type: 'string' }
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Signs on the page.',
        schema: { type: 'integer', minimum: 1, maximum: LIMITS.pageMax, default: LIMITS.pageDefault }
      }
    ],
    response: 'SignPage'
  },
  {
    operationId: 'listSignsNear',
    method: 'get',
    path: '/signs/near',
    summary: 'Signs nearest a point',
    description:
      `The ${LIMITS.nearMax} nearest signs with a pin, nearest first, each with its straight-line \`miles\`. ` +
      'A sign nobody placed is left out.',
    params: [lat, lng],
    response: 'NearSigns'
  },
  {
    operationId: 'listSimilarSigns',
    method: 'get',
    path: '/signs/similar',
    summary: 'Signs that may be this one',
    description:
      `Signs within ${LIMITS.similarMiles} miles that share at least half of the given numbers, ` +
      'for "Nobody has posted this sign yet" before posting. An empty list means none.',
    params: [
      lat,
      lng,
      {
        name: 'numbers',
        in: 'query',
        required: true,
        description: `The numbers read off the sign, comma separated, at most ${LIMITS.similarNumbersMax}.`,
        schema: { type: 'string', examples: ['90,82,8,7'] }
      }
    ],
    response: 'SimilarSigns'
  },
  {
    operationId: 'getSign',
    method: 'get',
    path: '/signs/{id}',
    summary: 'One sign and its ways',
    description:
      'By id or by slug. The ways are oldest first; the first is the poster’s, unless it was posted unsolved.',
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The sign’s id or slug.',
        schema: { type: 'string' }
      }
    ],
    response: 'SignDetail'
  },
  {
    operationId: 'getMap',
    method: 'get',
    path: '/map',
    summary: 'Every sign with a pin, for the map',
    description: 'Every sign, with or without a pin (`lat` and `lng` are null without), and the years they span.',
    params: [],
    response: 'MapPins'
  },
  {
    operationId: 'listPlayers',
    method: 'get',
    path: '/players',
    summary: 'Who’s playing',
    description: 'Every player with at least one sign, the one with the latest sign first.',
    params: [],
    response: 'Players'
  },
  {
    operationId: 'getPlayer',
    method: 'get',
    path: '/players/{handle}',
    summary: 'One player and their signs',
    description: 'A player’s signs are the ones they found, newest first.',
    params: [
      {
        name: 'handle',
        in: 'path',
        required: true,
        description: 'The player’s handle.',
        schema: { type: 'string' }
      }
    ],
    response: 'PlayerDetail'
  }
];
