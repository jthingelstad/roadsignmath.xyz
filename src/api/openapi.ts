// The `/api/v1` API as OpenAPI 3.1, built from src/api/contract.ts. Served at
// /api/v1/openapi.json and kept in contracts/api-surface.json.

import { createHash } from 'node:crypto';
import { BIO_MAX, NAME_MAX } from '../auth/account.ts';
import { LOGIN_TTL } from '../auth/auth.ts';
import { API_VERSION, ERRORS, ROUTES } from './contract.ts';

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
    way_count: int
  }),
  Way: object({
    id: str,
    text: { type: 'string', description: 'Canonical text: Unicode operators, √ for square roots.' },
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
    found_on: { type: 'string', format: 'date' },
    thumb_url: nullable({ type: 'string', format: 'uri' })
  }),
  MapPins: object({ pins: array(ref('Pin')), years: array({ type: 'integer' }) }),
  Player: object({
    handle: str,
    name: str,
    avatar_color: { type: 'string', pattern: '^#[0-9A-F]{6}$' },
    bio: nullable(str),
    url: { type: 'string', format: 'uri' },
    sign_count: int,
    states: array(str),
    first_year: nullable({ type: 'integer' })
  }),
  Players: object({ players: array(ref('Player')) }),
  PlayerDetail: {
    allOf: [ref('Player'), object({ signs: array(ref('Sign')) })]
  },
  Me: {
    allOf: [
      ref('Player'),
      object({
        email: { type: 'string', format: 'email', description: 'Only ever sent to you.' },
        needs_name: { type: 'boolean', description: 'True until you give a name; ask for one before posting.' }
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
    const hasInput = route.params.length > 0 || route.body !== undefined;
    const limited = route.operationId === 'startSignIn' || route.operationId === 'finishSignIn';
    paths[path] ??= {};
    paths[path][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      ...(route.auth === 'signed_in' ? { security: [{ token: [] }] } : {}),
      ...(route.params.length ? { parameters: route.params } : {}),
      ...(route.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: ref(route.body) } } } }
        : {}),
      responses: {
        [route.status]: {
          description: route.summary,
          headers: { 'API-Version': { schema: { type: 'string' }, description: 'This server’s API version.' } },
          ...(route.response ? { content: { 'application/json': { schema: ref(route.response) } } } : {})
        },
        ...(hasInput ? { '400': errorAnswer(ERRORS.bad_request) } : {}),
        ...(route.auth === 'signed_in' || route.operationId === 'finishSignIn'
          ? { '401': errorAnswer(ERRORS.unauthorized) }
          : {}),
        ...(route.path.includes('{') ? { '404': errorAnswer(ERRORS.not_found) } : {}),
        ...(limited ? { '429': errorAnswer(ERRORS.rate_limited) } : {})
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
        'sign-in by email and your own account for the app. ' +
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
