// The `/api/v1` surface in one place: the version, the routes, the limits and the error codes.
// The app registers a handler for each route by its operation id, and src/api/openapi.ts
// describes the same table, so the contract can't drift from the code.

/**
 * Bump on every change to the surface. tools/export-api-contract.ts refuses a changed surface
 * under a version already in contracts/api-versions.json.
 */
export const API_VERSION = '1.1.0';

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
  bad_request: 'A parameter or the body is missing or out of range; the message says which.',
  unauthorized: 'No token, a token that has ended, or a sign-in code that is wrong or too old.',
  not_found: 'No such route, sign or player.',
  rate_limited: 'Too many tries for now; the message says when to try again.',
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
  method: 'get' | 'post' | 'patch' | 'delete';
  /** OpenAPI form, under /api/v1: "/signs/{id}". */
  path: string;
  summary: string;
  description: string;
  params: Param[];
  /** public: anyone, and a token is checked when one is sent. signed_in: a token is required. */
  auth: 'public' | 'signed_in';
  /** The JSON body's schema name in openapi.ts, when it takes one. */
  body?: string;
  status: 200 | 202 | 204;
  /** The answer's schema name in openapi.ts; none for 204. */
  response?: string;
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
    auth: 'public',
    status: 200,
    response: 'Index'
  },
  {
    operationId: 'getOpenApi',
    method: 'get',
    path: '/openapi.json',
    summary: 'This description',
    description: 'OpenAPI 3.1, the same document as contracts/api-surface.json in the repo.',
    params: [],
    auth: 'public',
    status: 200,
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
    auth: 'public',
    status: 200,
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
    auth: 'public',
    status: 200,
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
    auth: 'public',
    status: 200,
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
    auth: 'public',
    status: 200,
    response: 'SignDetail'
  },
  {
    operationId: 'getMap',
    method: 'get',
    path: '/map',
    summary: 'Every sign with a pin, for the map',
    description: 'Every sign, with or without a pin (`lat` and `lng` are null without), and the years they span.',
    params: [],
    auth: 'public',
    status: 200,
    response: 'MapPins'
  },
  {
    operationId: 'listPlayers',
    method: 'get',
    path: '/players',
    summary: 'Who’s playing',
    description: 'Every player with at least one sign, the one with the latest sign first.',
    params: [],
    auth: 'public',
    status: 200,
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
    auth: 'public',
    status: 200,
    response: 'PlayerDetail'
  },
  {
    operationId: 'startSignIn',
    method: 'post',
    path: '/auth/start',
    summary: 'Email a sign-in link and code',
    description:
      'Sends a link that opens the app and a 6-digit code, both good for 15 minutes. The answer is the same ' +
      'whether or not the address has an account; the first sign-in makes one. At most 5 emails an hour to ' +
      'an address.',
    params: [],
    auth: 'public',
    body: 'SignInStart',
    status: 202,
    response: 'SignInStarted'
  },
  {
    operationId: 'finishSignIn',
    method: 'post',
    path: '/auth/verify',
    summary: 'Trade the link’s token or the code for an app token',
    description:
      'Send `login_id` with either the `token` from the link or the `code` from the email. Five wrong codes ' +
      'end the sign-in. The answer’s `token` goes in `Authorization: Bearer` from then on; it lasts until ' +
      'sign-out, or 180 days without use.',
    params: [],
    auth: 'public',
    body: 'SignInFinish',
    status: 200,
    response: 'SignedIn'
  },
  {
    operationId: 'signOut',
    method: 'post',
    path: '/auth/signout',
    summary: 'End this token',
    description: 'Other devices stay signed in.',
    params: [],
    auth: 'signed_in',
    status: 204
  },
  {
    operationId: 'getMe',
    method: 'get',
    path: '/me',
    summary: 'You',
    description: 'Your public profile, plus your email and whether you still need to give a name.',
    params: [],
    auth: 'signed_in',
    status: 200,
    response: 'Me'
  },
  {
    operationId: 'updateMe',
    method: 'patch',
    path: '/me',
    summary: 'Change your name or bio',
    description:
      'The first name you give also sets your handle, the address of your page; it stays after that. ' +
      'A null or empty bio removes it.',
    params: [],
    auth: 'signed_in',
    body: 'MeUpdate',
    status: 200,
    response: 'Me'
  },
  {
    operationId: 'deleteMe',
    method: 'delete',
    path: '/me',
    summary: 'Delete your account',
    description:
      'Deletes your account and everything it made: the signs you posted (with every way on them), the ways ' +
      'you found on other signs, your name among a sign’s finders, and your email. It can’t be undone.',
    params: [],
    auth: 'signed_in',
    status: 204
  }
];
