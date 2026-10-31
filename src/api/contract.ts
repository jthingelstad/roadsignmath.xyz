// The `/api/v1` surface in one place: the version, the routes, the limits and the error codes.
// The app registers a handler for each route by its operation id, and src/api/openapi.ts
// describes the same table, so the contract can't drift from the code.

/**
 * Bump on every change to the surface. tools/export-api-contract.ts refuses a changed surface
 * under a version already in contracts/api-versions.json.
 */
export const API_VERSION = '1.6.0';

export const LIMITS = {
  /** Signs per page of the feed. */
  pageDefault: 20,
  pageMax: 50,
  /** Signs in a "Near you" answer. */
  nearMax: 50,
  /** How far "Nobody has posted this sign yet" looks, in miles. */
  similarMiles: 2,
  /** Numbers a similar-sign question may send. */
  similarNumbersMax: 30,
  /** Posting. */
  photosMax: 4,
  photoBytes: 4 * 1024 * 1024,
  titleMax: 60,
  captionMax: 500,
  placeMax: 120,
  numbersMax: 30,
  findersMax: 6,
  wayMax: 400,
  reportMax: 300,
  /** Seconds an upload waits to be posted, and an Idempotency-Key is remembered. */
  uploadTtl: 86400,
  /** Tries a day per player. */
  uploadsADay: 60,
  postsADay: 20,
  waysADay: 100,
  reportsADay: 20,
  /** Hearts given or taken back a day per player. */
  heartsADay: 200,
  /** App screen views: in one batch, batches an hour from one network, and batches an hour in all. */
  viewsMax: 20,
  viewPathMax: 100,
  viewBatchesAnHour: 120,
  viewBatchesAllAnHour: 400
} as const;

export const ERRORS = {
  bad_request: 'A parameter or the body is missing or out of range; the message says which.',
  unauthorized: 'No token, a token that has ended, or a sign-in code that is wrong or too old.',
  not_found: 'No such route, sign or player.',
  conflict: 'It already exists (that way was found), or the same post is still being made.',
  too_large: `The photo is over ${LIMITS.photoBytes / 1024 / 1024} MB.`,
  rate_limited: 'Too many tries for now; the message says when to try again.',
  internal: 'Something broke on the server.',
  unavailable: 'The moderator or the hearts counter couldn’t answer just now; try again in a minute.'
} as const;

export type ErrorCode = keyof typeof ERRORS;

export type Param = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
};

export type Route = {
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI form, under /api/v1: "/signs/{id}". */
  path: string;
  summary: string;
  description: string;
  params: Param[];
  /** public: anyone, and a token is checked when one is sent. signed_in: a token is required. */
  auth: 'public' | 'signed_in';
  /** The JSON body's schema name in openapi.ts, when it takes one. */
  body?: string;
  /** The media types of a raw body (a photo), instead of JSON. */
  bodyMedia?: string[];
  /** Errors beyond the ones every route of its kind can give. */
  errors?: ErrorCode[];
  status: 200 | 201 | 202 | 204;
  /** The answer's schema name in openapi.ts; none for 204. */
  response?: string;
  /** The media type of a raw answer (a photo), instead of JSON. */
  responseMedia?: string;
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

const signId: Param = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The sign’s id or slug.',
  schema: { type: 'string' }
};
const handle: Param = {
  name: 'handle',
  in: 'path',
  required: true,
  description: 'The player’s handle.',
  schema: { type: 'string' }
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
    params: [signId],
    auth: 'public',
    status: 200,
    response: 'SignDetail'
  },
  {
    operationId: 'getMap',
    method: 'get',
    path: '/map',
    summary: 'Every sign with a pin, for the map',
    description:
      'Every sign, with or without a pin (`lat` and `lng` are null without), and the years they span. Each pin ' +
      'carries its place, numbers and finders, so a map can search every sign by town, state, number or person ' +
      'from this one answer.',
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
    summary: 'One player, their signs and their badges',
    description:
      'A player’s signs are the ones they found, newest first. Their badges are the ones they earned, in ' +
      'catalog order, worked out from the signs and ways you can see.',
    params: [handle],
    auth: 'public',
    status: 200,
    response: 'PlayerDetail'
  },
  {
    operationId: 'getBadges',
    method: 'get',
    path: '/badges',
    summary: 'Every badge there is',
    description:
      'Badges are little road signs a player collects for what happened on the road: a new state, a square ' +
      'root, a sign found a year after the first. Nothing is added up or compared. A secret badge gives only ' +
      'its id and shelf. A player’s earned badges are in `GET /players/{handle}` and `GET /me`.',
    params: [],
    auth: 'public',
    status: 200,
    response: 'BadgeCatalog'
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
    errors: ['rate_limited'],
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
    errors: ['rate_limited'],
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
      'Deletes your account and everything it made: the signs you posted (with every way and heart on them), ' +
      'the ways you found and the hearts you gave on other signs, your name among a sign’s finders, and your ' +
      'email. It can’t be undone. A 503 means a heart couldn’t be taken back just now and nothing more was ' +
      'deleted; try again in a minute. A 409 means one of your hearts was changing; try again.',
    params: [],
    auth: 'signed_in',
    errors: ['conflict', 'unavailable'],
    status: 204
  },
  {
    operationId: 'listBlocks',
    method: 'get',
    path: '/me/blocks',
    summary: 'Players you blocked',
    description: 'Their signs and ways are left out of everything you read.',
    params: [],
    auth: 'signed_in',
    status: 200,
    response: 'Blocks'
  },
  {
    operationId: 'getMyPhoto',
    method: 'get',
    path: '/me/photos/{photoId}/{size}',
    summary: 'A photo of one of your signs',
    description:
      'One size of a photo on a sign you posted. A held or hidden sign’s photos are served only here, ' +
      'to you; the summary’s `url` and `thumb_url` point here for them. Never cached.',
    params: [
      {
        name: 'photoId',
        in: 'path',
        required: true,
        description: 'The photo’s id.',
        schema: { type: 'string' }
      },
      {
        name: 'size',
        in: 'path',
        required: true,
        description: 'large (1600 px) or thumb (480 px).',
        schema: { type: 'string', enum: ['large', 'thumb'] }
      }
    ],
    auth: 'signed_in',
    status: 200,
    responseMedia: 'image/jpeg'
  },
  {
    operationId: 'uploadPhoto',
    method: 'post',
    path: '/photos',
    summary: 'Upload a photo for a post',
    description:
      `The body is the photo itself, JPEG, PNG or WebP, at most ${LIMITS.photoBytes / 1024 / 1024} MB. ` +
      'It is kept at two sizes with its metadata (and so its location) removed. Send the answer’s `id` ' +
      `in \`photo_ids\` when posting, within a day. At most ${LIMITS.uploadsADay} a day.`,
    params: [],
    auth: 'signed_in',
    bodyMedia: ['image/jpeg', 'image/png', 'image/webp'],
    errors: ['too_large', 'rate_limited'],
    status: 201,
    response: 'Upload'
  },
  {
    operationId: 'postSign',
    method: 'post',
    path: '/signs',
    summary: 'Post a sign',
    description:
      'Posts the uploaded photos with the numbers you checked, where and when you found it, who found it ' +
      '(you, unless you say), and optionally the first way to make it true. Without a way it is posted ' +
      'unsolved. `unlocked` lists the badges the post earned you. Our moderator looks first: a post that is clearly objectionable is held, and only you see ' +
      'it, with `moderation_note` saying why. The moderator also writes each photo’s alt text. You need a ' +
      `name first. At most ${LIMITS.postsADay} a day.`,
    params: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          'Any 8 to 128 letters, digits, - or _. Sending the same post again with the same key gives back ' +
          'the sign it made instead of a second one, for a day.',
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' }
      }
    ],
    auth: 'signed_in',
    body: 'SignPost',
    errors: ['conflict', 'rate_limited', 'unavailable'],
    status: 201,
    response: 'SignAndBadges'
  },
  {
    operationId: 'deleteSign',
    method: 'delete',
    path: '/signs/{id}',
    summary: 'Delete a sign you posted',
    description:
      'Removes the sign, its photos, every way on it and its hearts. A 503 means its hearts couldn’t be ' +
      'removed just now and the sign is still there; try again in a minute.',
    params: [signId],
    auth: 'signed_in',
    errors: ['unavailable'],
    status: 204
  },
  {
    operationId: 'addWay',
    method: 'post',
    path: '/signs/{id}/ways',
    summary: 'Add another way to make a sign true',
    description:
      'The math must be true, and every number in it must be one of the sign’s numbers, each used no more ' +
      'often than the sign shows it. A way someone already found is a conflict. Answers with the sign, ' +
      `all its ways, and in \`unlocked\` the badges the way earned you. You need a name first. At most ${LIMITS.waysADay} a day.`,
    params: [signId],
    auth: 'signed_in',
    body: 'WayPost',
    errors: ['conflict', 'rate_limited'],
    status: 201,
    response: 'SignAndBadges'
  },
  {
    operationId: 'heartSign',
    method: 'put',
    path: '/signs/{id}/heart',
    summary: 'Heart a sign',
    description:
      'One heart per player per sign; hearting it again changes nothing. Only a shown sign can be hearted. ' +
      'Answers with `hearted` and the sign’s `hearts`, which counts the website’s hearts too (null when the ' +
      'count can’t be read just now). A 503 means the heart couldn’t be counted and nothing changed. ' +
      `At most ${LIMITS.heartsADay} hearts given or taken back a day.`,
    params: [signId],
    auth: 'signed_in',
    errors: ['rate_limited', 'conflict', 'unavailable'],
    status: 200,
    response: 'HeartState'
  },
  {
    operationId: 'unheartSign',
    method: 'delete',
    path: '/signs/{id}/heart',
    summary: 'Take back your heart',
    description:
      'Taking back a heart you didn’t give changes nothing. A 503 means it couldn’t be taken back just now ' +
      'and nothing changed.',
    params: [signId],
    auth: 'signed_in',
    errors: ['rate_limited', 'conflict', 'unavailable'],
    status: 200,
    response: 'HeartState'
  },
  {
    operationId: 'reportSign',
    method: 'post',
    path: '/signs/{id}/report',
    summary: 'Report a sign',
    description:
      'Our moderator looks at the sign again with your reason, and hides it if it agrees it is objectionable. ' +
      `One report per sign; sending another gives back the first answer. At most ${LIMITS.reportsADay} a day.`,
    params: [signId],
    auth: 'signed_in',
    body: 'ReportPost',
    errors: ['rate_limited', 'unavailable', 'conflict'],
    status: 200,
    response: 'ReportOutcome'
  },
  {
    operationId: 'countAppViews',
    method: 'post',
    path: '/app/views',
    summary: 'Count the app’s screen views',
    description:
      `Up to ${LIMITS.viewsMax} screen views at once, each the path of the website page it matches ` +
      '(`/`, `/map`, `/signs/<slug>`, `/players/<handle>`) or a short one of its own (`/capture`): lowercase ' +
      'letters, digits and hyphens, at most two parts. They are counted in the site’s analytics as the app’s, ' +
      'with the request’s User-Agent and country and nothing about who sent them; signed in or not makes no ' +
      'difference. The answer comes once they are passed on, or a moment later if the counter is slow; a view ' +
      `that can’t be counted is dropped. At most ${LIMITS.viewBatchesAnHour} batches an hour from one network.`,
    params: [],
    auth: 'public',
    body: 'AppViews',
    errors: ['rate_limited'],
    status: 202,
    response: 'AppViewsAccepted'
  },
  {
    operationId: 'blockPlayer',
    method: 'post',
    path: '/players/{handle}/block',
    summary: 'Block a player',
    description: 'Their signs and ways are left out of everything you read. They aren’t told.',
    params: [handle],
    auth: 'signed_in',
    status: 204
  },
  {
    operationId: 'unblockPlayer',
    method: 'delete',
    path: '/players/{handle}/block',
    summary: 'Unblock a player',
    description: 'Their signs and ways come back.',
    params: [handle],
    auth: 'signed_in',
    status: 204
  }
];
