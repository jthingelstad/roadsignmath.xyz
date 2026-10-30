// The `/api/v1` read API on Hono. Every answer carries `API-Version`; every error is
// `{"error": {"code", "message"}}`. Public reads are cached for a minute at the edge.

import { Hono, type Context } from 'hono';
import { normalizeNumber } from '../domain/equation.ts';
import { miles } from '../domain/geo.ts';
import type { Sign } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import { API_VERSION, LIMITS, ROUTES, type ErrorCode } from './contract.ts';
import { openApi } from './openapi.ts';
import {
  byNewest,
  isPublic,
  pinView,
  playerStats,
  playerView,
  signDetail,
  signSummary,
  type People,
  type Urls
} from './views.ts';

export type ApiOptions = { store: Store; urls: Urls };

const STATUS: Record<ErrorCode, 400 | 404 | 500> = { bad_request: 400, not_found: 404, internal: 500 };

class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

const fail = (code: ErrorCode, message: string): never => {
  throw new ApiError(code, message);
};

function numberParam(c: Context, name: string, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') return fail('bad_request', `${name} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return fail('bad_request', `${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function limitParam(c: Context): number {
  const raw = c.req.query('limit');
  if (raw === undefined) return LIMITS.pageDefault;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.pageMax) {
    return fail('bad_request', `limit must be a whole number from 1 to ${LIMITS.pageMax}`);
  }
  return value;
}

const encodeCursor = (sign: Sign): string =>
  Buffer.from(JSON.stringify([sign.postedAt, sign.id])).toString('base64url');

function decodeCursor(raw: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')) {
      return value as [string, string];
    }
  } catch {
    // falls through to the error below
  }
  return fail('bad_request', 'cursor is not one this API gave out');
}

/** How many of `wanted` the sign shows, each sign number matching once. */
function sharedNumbers(wanted: string[], sign: Sign): number {
  const left = new Map<string, number>();
  for (const n of sign.numbers) left.set(n.value, (left.get(n.value) ?? 0) + 1);
  let shared = 0;
  for (const n of wanted) {
    const count = left.get(n) ?? 0;
    if (count > 0) {
      left.set(n, count - 1);
      shared++;
    }
  }
  return shared;
}

type Handler = (c: Context, data: { signs: Sign[]; people: People }) => Promise<Response>;

export function createApi({ store, urls }: ApiOptions): Hono {
  const api = new Hono();

  /** Every shown sign, newest first, and every player by id. Read whole: there are few. */
  async function load(): Promise<{ signs: Sign[]; people: People }> {
    const [signs, players] = await Promise.all([store.allSigns(), store.allPlayers()]);
    return { signs: signs.filter(isPublic).sort(byNewest), people: new Map(players.map((p) => [p.id, p])) };
  }

  const handlers: Record<string, Handler> = {
    async getIndex(c, { signs, people }) {
      const finders = new Set(signs.flatMap((s) => s.finders.map((f) => f.playerId)).filter(Boolean));
      const states = new Set(signs.map((s) => s.place.state).filter(Boolean));
      return c.json({
        api_version: API_VERSION,
        signs: signs.length,
        players: [...people.keys()].filter((id) => finders.has(id)).length,
        states: states.size,
        openapi_url: `${urls.site}/api/v1/openapi.json`
      });
    },

    async getOpenApi(c) {
      return c.json(openApi());
    },

    async listSigns(c, { signs, people }) {
      const limit = limitParam(c);
      const raw = c.req.query('cursor');
      let start = 0;
      if (raw) {
        const [postedAt, id] = decodeCursor(raw);
        start = signs.findIndex((s) => byNewest(s, { postedAt, id } as Sign) > 0);
        if (start < 0) start = signs.length;
      }
      const page = signs.slice(start, start + limit);
      const more = start + limit < signs.length;
      return c.json({
        signs: page.map((s) => signSummary(urls, people, s)),
        next_cursor: more ? encodeCursor(page[page.length - 1]) : null
      });
    },

    async listSignsNear(c, { signs, people }) {
      const lat = numberParam(c, 'lat', -90, 90);
      const lng = numberParam(c, 'lng', -180, 180);
      const near = signs
        .filter((s) => s.place.lat !== undefined && s.place.lng !== undefined)
        .map((s) => ({ sign: s, miles: miles(lat, lng, s.place.lat!, s.place.lng!) }))
        .sort((a, b) => a.miles - b.miles)
        .slice(0, LIMITS.nearMax);
      return c.json({
        signs: near.map((n) => ({ ...signSummary(urls, people, n.sign), miles: Math.round(n.miles * 10) / 10 }))
      });
    },

    async listSimilarSigns(c, { signs, people }) {
      const lat = numberParam(c, 'lat', -90, 90);
      const lng = numberParam(c, 'lng', -180, 180);
      const raw = (c.req.query('numbers') ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      if (raw.length === 0) fail('bad_request', 'numbers is required');
      if (raw.length > LIMITS.similarNumbersMax) {
        fail('bad_request', `numbers may hold at most ${LIMITS.similarNumbersMax}`);
      }
      if (!raw.every((n) => /^\d*\.?\d+$|^\d+\.$/.test(n))) fail('bad_request', 'numbers must be plain numbers');
      const wanted = raw.map(normalizeNumber);
      const similar = signs
        .filter((s) => s.place.lat !== undefined && s.place.lng !== undefined)
        .map((s) => ({ sign: s, miles: miles(lat, lng, s.place.lat!, s.place.lng!) }))
        .filter((n) => n.miles <= LIMITS.similarMiles && sharedNumbers(wanted, n.sign) * 2 >= wanted.length)
        .sort((a, b) => a.miles - b.miles);
      return c.json({
        signs: similar.map((n) => ({ ...signSummary(urls, people, n.sign), miles: Math.round(n.miles * 10) / 10 }))
      });
    },

    async getSign(c, { signs, people }) {
      const key = c.req.param('id');
      const sign = signs.find((s) => s.id === key || s.slug === key) ?? fail('not_found', 'No sign by that id');
      return c.json(signDetail(urls, people, sign, await store.listWays(sign.id)));
    },

    async getMap(c, { signs }) {
      const years = [...new Set(signs.map((s) => Number(s.foundOn.slice(0, 4))))].sort((a, b) => a - b);
      return c.json({ pins: signs.map((s) => pinView(urls, s)), years });
    },

    async listPlayers(c, { signs, people }) {
      const playing = [...people.values()]
        .map((player) => ({ player, latest: playerStats(player, signs).signs[0] }))
        .filter((p) => p.latest)
        .sort((a, b) => byNewest(a.latest, b.latest));
      return c.json({ players: playing.map((p) => playerView(urls, p.player, signs)) });
    },

    async getPlayer(c, { signs, people }) {
      const handle = c.req.param('handle');
      const player =
        [...people.values()].find((p) => p.handle === handle) ?? fail('not_found', 'No player by that handle');
      const stats = playerStats(player, signs);
      return c.json({
        ...playerView(urls, player, signs),
        signs: stats.signs.map((s) => signSummary(urls, people, s))
      });
    }
  };

  api.use('*', async (c, next) => {
    await next();
    c.header('API-Version', API_VERSION);
    if (c.req.method === 'GET' && c.res.status === 200) c.header('Cache-Control', 'public, max-age=60');
    else c.header('Cache-Control', 'no-store');
  });

  for (const route of ROUTES) {
    const handler = handlers[route.operationId];
    if (!handler) throw new Error(`No handler for ${route.operationId}`);
    const path = route.path.replace(/\{(\w+)\}/g, ':$1') || '/';
    api.on(route.method.toUpperCase(), path, async (c) => handler(c, await load()));
  }

  api.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, STATUS[err.code]);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something broke on the server' } }, 500);
  });

  return api;
}

/** The whole server: the API under /api/v1. The website joins it in a later step. */
export function createApp(options: ApiOptions): Hono {
  const app = new Hono();
  app.route('/api/v1', createApi(options));
  app.notFound((c) => {
    if (!c.req.path.startsWith('/api/')) return c.text('Not found', 404);
    c.header('API-Version', API_VERSION);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'not_found', message: 'No such route' } }, 404);
  });
  return app;
}
