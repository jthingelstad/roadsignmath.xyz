// The `/api/v1` API as OpenAPI 3.1, built from src/api/contract.ts. Served at
// /api/v1/openapi.json and kept in contracts/api-surface.json.

import { createHash } from 'node:crypto';
import { BIO_MAX, NAME_MAX } from '../auth/account.ts';
import { LOGIN_TTL } from '../auth/auth.ts';
import { API_VERSION, ERRORS, LIMITS, ROUTES, type ErrorCode } from './contract.ts';
import { STATUS } from './errors.ts';
import { SHELVES } from '../domain/badges.ts';
import { AVATAR_SIZES } from '../photos.ts';
import { VIEW_PATH } from '../tinylytics.ts';

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, Schema>, description?: string): Schema => ({
  type: 'object',
  ...(description ? { description } : {}),
  required: Object.keys(properties),
  properties
});
const array = (items: Schema): Schema => ({ type: 'array', items });
const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer', minimum: 0 };

const SCHEMAS: Record<string, Schema> = {
  Error: object({
    error: object({ code: { type: 'string', enum: Object.keys(ERRORS) }, message: str })
  }),
  Index: object({
    api_version: { type: 'string', examples: [API_VERSION] },
    signs: int,
    players: int,
    states: int,
    openapi_url: { type: 'string', format: 'uri' }
  }),
  OpenApi: { type: 'object', description: 'This document.' },
  Place: object({
    label: { type: 'string', examples: ['I-35W, Bloomington, Minnesota'] },
    state: nullable({ type: 'string', description: 'Two-letter US state.' }),
    lat: nullable({ type: 'number' }),
    lng: nullable({ type: 'number' }),
    approximate: { type: 'boolean', description: 'True when the pin is only as good as a town.' }
  }),
  Photo: object({
    id: str,
    width: int,
    height: int,
    alt: str,
    url: { type: 'string', format: 'uri' },
    thumb_url: { type: 'string', format: 'uri' }
  }),
  SignNumber: object(
    {
      value: { type: 'string', description: 'The number the math may use, as decimal text.', examples: ['7'] },
      text: nullable({ type: 'string', description: 'What it was read from.', examples: ['EXIT 7B'] }),
      why: nullable({ type: 'string', description: 'Why the value differs from the text.', examples: ['Read as 7'] }),
      box: nullable({
        type: 'array',
        description: 'Where on the first photo: x, y, width, height as fractions, origin top left.',
        items: { type: 'number', minimum: 0, maximum: 1 },
        minItems: 4,
        maxItems: 4
      })
    },
    'A number on the sign, as its poster checked it.'
  ),
  Finder: object({
    name: str,
    handle: nullable(str),
    role: { type: 'string', enum: ['found', 'took_photo', 'spotted'] }
  }),
  FirstWay: object({
    text: { type: 'string', examples: ['3 × 33 = 99'] },
    tex: nullable({
      type: 'string',
      description: 'LaTeX for drawing the math (÷ as a stacked fraction); null only if the text no longer parses.',
      examples: ['3 \\times 33 = 99']
    }),
    value: { type: 'string', examples: ['99'] }
  }),
  Sign: object({
    id: str,
    slug: str,
    title: str,
    url: { type: 'string', format: 'uri' },
    caption: nullable(str),
    found_on: { type: 'string', format: 'date' },
    posted_at: { type: 'string', format: 'date-time' },
    posted_by: nullable(str),
    place: ref('Place'),
    photos: array(ref('Photo')),
    numbers: array(ref('SignNumber')),
    finders: array(ref('Finder')),
    first_way: nullable(ref('FirstWay')),
    way_count: int,
    hearts: nullable({
      ...int,
      description:
        'Hearts on the sign, from the website and the app together; null when they can’t be counted just now.'
    }),
    hearted: nullable({ type: 'boolean', description: 'Whether you hearted it; null when not signed in.' }),
    visibility: {
      type: 'string',
      enum: ['shown', 'held', 'hidden'],
      description: 'Always shown, except on your own signs: held when posted, hidden after a report.'
    },
    moderation_note: nullable({ type: 'string', description: 'Why your sign is held or hidden; null when shown.' })
  }),
  Way: object({
    id: str,
    text: { type: 'string', description: 'Canonical text: Unicode operators, √ for square roots.' },
    tex: nullable({
      type: 'string',
      description: 'LaTeX for drawing the math (÷ as a stacked fraction); null only if the text no longer parses.',
      examples: ['3 \\times 33 = 99']
    }),
    value: { type: 'string', description: 'What both sides equal.' },
    numbers: array(str),
    by: nullable(object({ handle: str, name: str })),
    created_at: { type: 'string', format: 'date-time' }
  }),
  SignDetail: {
    allOf: [ref('Sign'), object({ ways: array(ref('Way')) })]
  },
  SignPage: object({ signs: array(ref('Sign')), next_cursor: nullable(str) }),
  NearSigns: object({
    signs: array({ allOf: [ref('Sign'), object({ miles: { type: 'number', minimum: 0 } })] })
  }),
  PopularSigns: object({ signs: array(ref('Sign')) }),
  SimilarSigns: object({
    signs: array({ allOf: [ref('Sign'), object({ miles: { type: 'number', minimum: 0 } })] })
  }),
  Pin: object({
    id: str,
    slug: str,
    title: str,
    url: { type: 'string', format: 'uri' },
    lat: nullable({ type: 'number' }),
    lng: nullable({ type: 'number' }),
    approximate: { type: 'boolean' },
    state: nullable(str),
    place_label: { type: 'string', description: 'Where it was, as the sign’s `place.label`.' },
    found_on: { type: 'string', format: 'date' },
    numbers: array({
      type: 'string',
      description: 'The values of the sign’s checked numbers, in the sign’s order.',
      examples: ['7']
    }),
    finders: array(object({ name: str, handle: nullable(str) })),
    thumb_url: nullable({ type: 'string', format: 'uri' }),
    hearts: nullable({
      ...int,
      description:
        'Hearts on the sign, from the website and the app together; null when they can’t be counted just now.'
    }),
    hearted: nullable({ type: 'boolean', description: 'Whether you hearted it; null when not signed in.' })
  }),
  MapPins: object({ pins: array(ref('Pin')), years: array({ type: 'integer' }) }),
  Player: object({
    handle: str,
    name: str,
    avatar_color: {
      type: 'string',
      pattern: '^#[0-9A-F]{6}$',
      description: 'Behind the first letter of the name, when there is no profile photo.'
    },
    avatar_url: nullable({
      type: 'string',
      format: 'uri',
      description: `The profile photo, ${AVATAR_SIZES.large} pixels square, JPEG; null when there is none.`
    }),
    avatar_thumb_url: nullable({
      type: 'string',
      format: 'uri',
      description: `The profile photo at ${AVATAR_SIZES.thumb} pixels square, for small faces.`
    }),
    bio: nullable(str),
    url: { type: 'string', format: 'uri' },
    sign_count: int,
    states: array(str),
    first_year: nullable({ type: 'integer' })
  }),
  Players: object({ players: array(ref('Player')) }),
  PlayerDetail: {
    allOf: [ref('Player'), object({ signs: array(ref('Sign')), badges: array(ref('EarnedBadge')) })]
  },
  CatalogBadge: object(
    {
      id: str,
      shelf: { type: 'string', enum: [...SHELVES] },
      secret: { type: 'boolean', description: 'A secret badge gives only its id and shelf until someone earns it.' },
      name: nullable(str),
      how: nullable({ type: 'string', description: 'How it is earned, in a line.' }),
      mark: nullable({ type: 'string', description: 'What its sign shows: a word, a symbol or a number.' }),
      steps: nullable({ ...array(int), description: 'For a badge earned in steps, each step’s count.' })
    },
    'A badge in the catalog. Each shelf is drawn as a family of road signs.'
  ),
  BadgeCatalog: object({ badges: array(ref('CatalogBadge')) }),
  EarnedBadge: object(
    {
      id: str,
      shelf: { type: 'string', enum: [...SHELVES] },
      name: str,
      how: str,
      mark: { type: 'string', description: 'What its sign shows; a stepped badge shows its step.' },
      step: nullable({ ...int, description: 'The step reached, for a badge earned in steps.' }),
      earned_on: {
        type: 'string',
        format: 'date',
        description:
          'The day the sign was found, in the finder’s own time. For the math, a way posted with its sign takes that day too; a way added later takes the day it was written in US Central.'
      },
      sign: object({ id: str, slug: str, title: str, url: { type: 'string', format: 'uri' } })
    },
    'A badge a player earned, with the sign that earned it first. Badges follow the signs on the map, so one ' +
      'goes when its sign does.'
  ),
  SignAndBadges: {
    allOf: [
      ref('SignDetail'),
      object({
        unlocked: {
          ...array(ref('EarnedBadge')),
          description: 'Badges this post or way earned you just now, or a higher step of one.'
        }
      })
    ]
  },
  Me: {
    allOf: [
      ref('Player'),
      object({
        email: { type: 'string', format: 'email', description: 'Only ever sent to you.' },
        needs_name: { type: 'boolean', description: 'True until you give a name; ask for one before posting.' },
        badges: array(ref('EarnedBadge'))
      })
    ]
  },
  MeUpdate: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
      bio: nullable({ type: 'string', maxLength: BIO_MAX })
    }
  },
  Blocks: object({ players: array(object({ handle: str, name: str })) }),
  Upload: object({
    id: { type: 'string', description: 'Send it in `photo_ids` when posting.' },
    width: int,
    height: int
  }),
  SignPost: {
    type: 'object',
    additionalProperties: false,
    required: ['photo_ids', 'title', 'numbers', 'place', 'found_on'],
    properties: {
      photo_ids: { type: 'array', items: str, minItems: 1, maxItems: LIMITS.photosMax },
      title: { type: 'string', minLength: 1, maxLength: LIMITS.titleMax },
      caption: nullable({ type: 'string', maxLength: LIMITS.captionMax }),
      numbers: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.numbersMax,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: {
            value: { type: 'string', pattern: '^[0-9]*\\.?[0-9]+$', examples: ['7'] },
            text: nullable({ type: 'string', maxLength: 40 }),
            why: nullable({ type: 'string', maxLength: 60 }),
            box: nullable({
              type: 'array',
              items: { type: 'number', minimum: 0, maximum: 1 },
              minItems: 4,
              maxItems: 4
            })
          }
        }
      },
      place: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: LIMITS.placeMax },
          state: nullable({ type: 'string', pattern: '^[A-Z]{2}$' }),
          lat: nullable({ type: 'number', minimum: -90, maximum: 90 }),
          lng: nullable({ type: 'number', minimum: -180, maximum: 180 }),
          approximate: { type: 'boolean', default: false }
        }
      },
      found_on: { type: 'string', format: 'date', description: 'The day it was found, in your own time.' },
      finders: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.findersMax,
        description: 'Who found it: a player by handle, or a name for someone who doesn’t play. Default: you.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            handle: str,
            name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
            role: { type: 'string', enum: ['found', 'took_photo', 'spotted'], default: 'found' }
          }
        }
      },
      way: {
        type: 'string',
        maxLength: LIMITS.wayMax,
        description: 'The first way to make it true, as math text. Leave it out to post unsolved.',
        examples: ['90 − 82 = 8']
      }
    }
  },
  WayPost: object({ text: { type: 'string', maxLength: LIMITS.wayMax, examples: ['7 + 12 = 19'] } }),
  ReportPost: object({ reason: { type: 'string', minLength: 1, maxLength: LIMITS.reportMax } }),
  ReportOutcome: object({
    outcome: { type: 'string', enum: ['hidden', 'kept'] },
    note: { type: 'string', description: 'The moderator’s reason.' }
  }),
  HeartState: object({
    hearted: { type: 'boolean' },
    hearts: nullable({ ...int, description: 'The sign’s hearts now; null when they can’t be counted just now.' })
  }),
  AppViews: {
    type: 'object',
    additionalProperties: false,
    required: ['views'],
    properties: {
      views: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.viewsMax,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              maxLength: LIMITS.viewPathMax,
              pattern: VIEW_PATH.source,
              examples: ['/signs/speed-limit-55', '/map']
            }
          }
        }
      }
    }
  },
  AppViewsAccepted: object({ accepted: { ...int, description: 'How many views were taken.' } }),
  SignInStart: object({ email: { type: 'string', format: 'email' } }),
  SignInStarted: object({
    login_id: { type: 'string', description: 'Send it back with the code or the link’s token.' },
    expires_in: { type: 'integer', description: 'Seconds the link and code work for.', examples: [LOGIN_TTL] }
  }),
  SignInFinish: {
    type: 'object',
    required: ['login_id'],
    description: 'The login_id and exactly one of code or token.',
    properties: {
      login_id: str,
      code: { type: 'string', pattern: '^[0-9]{6}$' },
      token: { type: 'string', description: 'The `t` parameter of the link in the email.' }
    }
  },
  SignedIn: object({
    token: { type: 'string', description: 'Send as `Authorization: Bearer <token>`.', pattern: '^rsm_' },
    new_player: { type: 'boolean', description: 'True when this sign-in made the account.' },
    me: ref('Me')
  })
};

const errorAnswer = (description: string): Schema => ({
  description,
  content: { 'application/json': { schema: ref('Error') } }
});

export function openApi(): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const route of ROUTES) {
    const path = `/api/v1${route.path}`;
    const hasInput = route.params.length > 0 || route.body !== undefined || route.bodyMedia !== undefined;
    const errors = new Set<ErrorCode>(route.errors);
    if (hasInput) errors.add('bad_request');
    if (route.auth === 'signed_in' || route.operationId === 'finishSignIn') errors.add('unauthorized');
    if (route.path.includes('{')) errors.add('not_found');
    const content = route.bodyMedia
      ? Object.fromEntries(route.bodyMedia.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]))
      : route.body && { 'application/json': { schema: ref(route.body) } };
    paths[path] ??= {};
    paths[path][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      ...(route.auth === 'signed_in' ? { security: [{ token: [] }] } : {}),
      ...(route.params.length ? { parameters: route.params } : {}),
      ...(content ? { requestBody: { required: true, content } } : {}),
      responses: {
        [route.status]: {
          description: route.summary,
          headers: { 'API-Version': { schema: { type: 'string' }, description: 'This server’s API version.' } },
          ...(route.response ? { content: { 'application/json': { schema: ref(route.response) } } } : {}),
          ...(route.responseMedia
            ? { content: { [route.responseMedia]: { schema: { type: 'string', format: 'binary' } } } }
            : {})
        },
        ...Object.fromEntries(
          [...errors]
            .sort((a, b) => STATUS[a] - STATUS[b])
            .map((code) => [String(STATUS[code]), errorAnswer(ERRORS[code])])
        )
      }
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Road Sign Math API',
      version: API_VERSION,
      summary: 'The signs, the map and the players of Road Sign Math.',
      description:
        'Every public sign, the ways people found to make it true, the map and who’s playing, read by anyone; ' +
        'sign-in by email, your own account, and posting signs and ways from the app. ' +
        'Answers are JSON in UTF-8 with snake_case keys and carry an `API-Version` header. ' +
        'A request with a token is never cached. ' +
        'An error is `{"error": {"code", "message"}}`.',
      license: { name: 'MIT', identifier: 'MIT' }
    },
    servers: [{ url: 'https://roadsignmath.xyz' }],
    paths,
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        token: { type: 'http', scheme: 'bearer', description: 'The `token` from `POST /api/v1/auth/verify`.' }
      }
    }
  };
}

/** Changes whenever the description does; recorded per version in contracts/api-versions.json. */
export const surfaceDigest = (): string => createHash('sha256').update(JSON.stringify(openApi())).digest('hex');
