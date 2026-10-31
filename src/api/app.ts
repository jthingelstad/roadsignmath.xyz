// The `/api/v1` API on Hono. Every answer carries `API-Version`; every error is
// `{"error": {"code", "message"}}`. Public reads are cached for a minute at the edge; a reader
// with a token also sees their own held signs and not the players they blocked.

import { Hono, type Context } from 'hono';
import { normalizeNumber } from '../domain/equation.ts';
import { miles } from '../domain/geo.ts';
import type { Sign, Way } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import { API_VERSION, LIMITS, ROUTES } from './contract.ts';
import { ApiError, fail, STATUS } from './errors.ts';
import { deleteAccount, updateMe } from '../auth/account.ts';
import { finishSignIn, network, signOut, startSignIn, viewerFor, type Viewer } from '../auth/auth.ts';
import { HeartCounts, heartView, setHeart } from '../hearts.ts';
import type { Mailer } from '../mail/mailer.ts';
import type { Moderator } from '../moderation/moderator.ts';
import type { PhotoStore } from '../photos.ts';
import { TinylyticsUnavailable, VIEW_PATH, type Hit, type Tinylytics } from '../tinylytics.ts';
import { nowSeconds } from '../store/store.ts';
import { limit } from './input.ts';
import { appSiteAssociation } from '../web/apple.ts';
import { createSite } from '../web/site.tsx';
import {
  addWay,
  blockPlayer,
  deleteSign,
  postSign,
  reportSign,
  unblockPlayer,
  uploadPhoto
} from '../posting/posting.ts';
import { openApi } from './openapi.ts';
import {
  byNewest,
  meView,
  pinView,
  playerStats,
  playerView,
  signDetail,
  isPublic,
  signSummary,
  visibleTo,
  type HeartView,
  type People,
  type Urls
} from './views.ts';

export type ApiOptions = {
  store: Store;
  urls: Urls;
  mailer: Mailer;
  photos: PhotoStore;
  moderator: Moderator;
  /** The address a request came from, for rate limits. */
  clientIp?: (c: Context) => string;
  /** The Apple Team ID that signs the iPhone app; without it there is no apple-app-site-association. */
  appleTeamId?: string;
  /** Hearts' counts and the app's views; without it hearts are off (counts null) and views dropped. */
  tinylytics?: Tinylytics;
};

/** The viewer's two-letter country from CloudFront, when it sent one. */
function viewerCountry(c: Context): string | undefined {
  const raw = c.req.header('cloudfront-viewer-country')?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) ? raw : undefined;
}

/** The body of `POST /app/views`: its paths, checked. */
function appViews(body: Record<string, unknown>): string[] {
  const extra = Object.keys(body).filter((k) => k !== 'views');
  if (extra.length) fail('bad_request', `Only views can be sent, not ${extra.join(', ')}`);
  const views = body.views;
  if (!Array.isArray(views) || views.length < 1 || views.length > LIMITS.viewsMax) {
    return fail('bad_request', `views is a list of 1 to ${LIMITS.viewsMax}`);
  }
  return views.map((v: unknown, i) => {
    const view = v as Record<string, unknown> | null;
    if (!view || typeof view !== 'object' || Array.isArray(view) || Object.keys(view).some((k) => k !== 'path')) {
      return fail('bad_request', `views[${i}] is an object with only a path`);
    }
    const path = view.path;
    if (typeof path !== 'string' || path.length > LIMITS.viewPathMax || !VIEW_PATH.test(path)) {
      return fail('bad_request', `views[${i}].path must look like /signs/<slug> or /map`);
    }
    return path;
  });
}

/** Behind CloudFront the viewer's address arrives as `CloudFront-Viewer-Address: <ip>:<port>`. */
export function cloudFrontIp(c: Context): string {
  const raw = c.req.header('cloudfront-viewer-address');
  return raw ? raw.slice(0, raw.lastIndexOf(':')).replace(/^\[|\]$/g, '') : 'unknown';
}

function numberParam(c: Context, name: string, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') return fail('bad_request', `${name} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return fail('bad_request', `${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

const pathParam = (c: Context, name: string): string => c.req.param(name) ?? fail('not_found', 'No such route');

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

type Data = { signs: Sign[]; people: People; blocked: Set<string> };
type Handler = (
  c: Context,
  ctx: { data: () => Promise<Data>; hearts: () => Promise<HeartView>; viewer?: Viewer }
) => Promise<Response>;

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => undefined)) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return fail('bad_request', 'The body must be a JSON object');
  return body as Record<string, unknown>;
}

export function createApi(options: ApiOptions): Hono {
  const { store, urls, mailer, clientIp = cloudFrontIp } = options;
  const { tinylytics } = options;
  const deps = { store, photos: options.photos, moderator: options.moderator, tinylytics };
  const heartDeps = { store, tinylytics, counts: new HeartCounts(tinylytics) };
  const api = new Hono();

  /** The signs this reader sees, newest first, and every player by id. Read whole: there are few. */
  async function load(viewer: Viewer | undefined): Promise<Data> {
    const [signs, players, blocks] = await Promise.all([
      store.allSigns(),
      store.allPlayers(),
      viewer ? store.listBlocks(viewer.player.id) : []
    ]);
    const blocked = new Set(blocks.map((b) => b.blockedId));
    return {
      signs: signs.filter(visibleTo(viewer?.player.id, blocked)).sort(byNewest),
      people: new Map(players.map((p) => [p.id, p])),
      blocked
    };
  }

  /** A sign this reader can see, by id or slug. */
  const findSign = (signs: Sign[], key: string): Sign =>
    signs.find((s) => s.id === key || s.slug === key) ?? fail('not_found', 'No sign by that id');

  const detail = (people: People, blocked: Set<string>, sign: Sign, ways: Way[], hearts: HeartView) =>
    signDetail(
      urls,
      people,
      sign,
      ways.filter((w) => !blocked.has(w.playerId)),
      hearts
    );

  const handlers: Record<string, Handler> = {
    async getIndex(c, { data }) {
      const { signs, people } = await data();
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

    async listSigns(c, { data, hearts }) {
      const [{ signs, people, blocked }, h] = await Promise.all([data(), hearts()]);
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
        signs: page.map((s) => signSummary(urls, people, s, blocked, h)),
        next_cursor: more ? encodeCursor(page[page.length - 1]) : null
      });
    },

    async listSignsNear(c, { data, hearts }) {
      const [{ signs, people, blocked }, h] = await Promise.all([data(), hearts()]);
      const lat = numberParam(c, 'lat', -90, 90);
      const lng = numberParam(c, 'lng', -180, 180);
      const near = signs
        .filter((s) => s.place.lat !== undefined && s.place.lng !== undefined)
        .map((s) => ({ sign: s, miles: miles(lat, lng, s.place.lat!, s.place.lng!) }))
        .sort((a, b) => a.miles - b.miles)
        .slice(0, LIMITS.nearMax);
      return c.json({
        signs: near.map((n) => ({
          ...signSummary(urls, people, n.sign, blocked, h),
          miles: Math.round(n.miles * 10) / 10
        }))
      });
    },

    async listSimilarSigns(c, { data, hearts }) {
      const [{ signs, people, blocked }, h] = await Promise.all([data(), hearts()]);
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
        signs: similar.map((n) => ({
          ...signSummary(urls, people, n.sign, blocked, h),
          miles: Math.round(n.miles * 10) / 10
        }))
      });
    },

    async getSign(c, { data, hearts }) {
      const [{ signs, people, blocked }, h] = await Promise.all([data(), hearts()]);
      const sign = findSign(signs, pathParam(c, 'id'));
      return c.json(detail(people, blocked, sign, await store.listWays(sign.id), h));
    },

    async getMap(c, { data, hearts }) {
      const [{ signs, people }, h] = await Promise.all([data(), hearts()]);
      const years = [...new Set(signs.map((s) => Number(s.foundOn.slice(0, 4))))].sort((a, b) => a - b);
      return c.json({ pins: signs.map((s) => pinView(urls, people, s, h)), years });
    },

    async listPlayers(c, { data }) {
      const { signs, people } = await data();
      const playing = [...people.values()]
        .map((player) => ({ player, latest: playerStats(player, signs).signs[0] }))
        .filter((p) => p.latest)
        .sort((a, b) => byNewest(a.latest, b.latest));
      return c.json({ players: playing.map((p) => playerView(urls, p.player, signs)) });
    },

    async getPlayer(c, { data, hearts }) {
      const [{ signs, people, blocked }, h] = await Promise.all([data(), hearts()]);
      const handle = pathParam(c, 'handle');
      const player =
        [...people.values()].find((p) => p.handle === handle) ?? fail('not_found', 'No player by that handle');
      const stats = playerStats(player, signs);
      return c.json({
        ...playerView(urls, player, signs),
        signs: stats.signs.map((s) => signSummary(urls, people, s, blocked, h))
      });
    },

    async startSignIn(c) {
      const body = await jsonBody(c);
      const link = (loginId: string, token: string) =>
        `${urls.site}/signin?l=${encodeURIComponent(loginId)}&t=${encodeURIComponent(token)}`;
      const started = await startSignIn({ store, mailer, link }, body.email, clientIp(c));
      return c.json({ login_id: started.loginId, expires_in: started.expiresIn }, 202);
    },

    async finishSignIn(c, { data }) {
      const body = await jsonBody(c);
      const done = await finishSignIn(store, { loginId: body.login_id, code: body.code, token: body.token });
      return c.json({ token: done.token, new_player: done.isNew, me: meView(urls, done.player, (await data()).signs) });
    },

    async signOut(c, { viewer }) {
      await signOut(store, viewer!);
      return c.body(null, 204);
    },

    async getMe(c, { data, viewer }) {
      return c.json(meView(urls, viewer!.player, (await data()).signs));
    },

    async updateMe(c, { data, viewer }) {
      const player = await updateMe(store, viewer!.player, await jsonBody(c));
      return c.json(meView(urls, player, (await data()).signs));
    },

    async deleteMe(c, { viewer }) {
      await deleteAccount(deps, viewer!.player);
      return c.body(null, 204);
    },

    async listBlocks(c, { data, viewer }) {
      const { people } = await data();
      const blocks = await store.listBlocks(viewer!.player.id);
      const players = blocks.map((b) => people.get(b.blockedId)).filter((p) => p !== undefined);
      return c.json({ players: players.map((p) => ({ handle: p.handle, name: p.name })) });
    },

    async getMyPhoto(c, { viewer }) {
      const photoId = pathParam(c, 'photoId');
      const size = pathParam(c, 'size');
      if (size !== 'large' && size !== 'thumb') return fail('bad_request', 'size is large or thumb');
      const none = () => fail('not_found', 'No photo of yours by that id');
      const mine =
        (await store.allSigns()).find(
          (s) => s.postedBy === viewer!.player.id && s.photos.some((p) => p.id === photoId)
        ) ?? none();
      const bytes = (await options.photos.get(photoId, size, isPublic(mine) ? 'shown' : 'held')) ?? none();
      return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' });
    },

    async uploadPhoto(c, { viewer }) {
      const length = c.req.header('content-length');
      const upload = await uploadPhoto(
        deps,
        viewer!.player,
        c.req.header('content-type'),
        () => c.req.arrayBuffer(),
        length === undefined ? undefined : Number(length)
      );
      return c.json(upload, 201);
    },

    async postSign(c, { hearts, viewer }) {
      const body = await jsonBody(c);
      const { sign, ways } = await postSign(deps, viewer!.player, body, c.req.header('idempotency-key'));
      const people = new Map((await store.allPlayers()).map((p) => [p.id, p]));
      // A replayed post can carry ways added since, by players the poster has blocked.
      const blocked = new Set((await store.listBlocks(viewer!.player.id)).map((b) => b.blockedId));
      return c.json(detail(people, blocked, sign, ways, await hearts()), 201);
    },

    async deleteSign(c, { data, viewer }) {
      const sign = findSign((await data()).signs, pathParam(c, 'id'));
      await deleteSign(deps, viewer!.player, sign);
      return c.body(null, 204);
    },

    async addWay(c, { data, hearts, viewer }) {
      const { signs, people, blocked } = await data();
      const sign = findSign(signs, pathParam(c, 'id'));
      const ways = await addWay(deps, viewer!.player, sign, await jsonBody(c));
      const fresh = (await store.getSign(sign.id)) ?? sign;
      return c.json(detail(people, blocked, fresh, ways, await hearts()), 201);
    },

    async heartSign(c, { data, viewer }) {
      const sign = findSign((await data()).signs, pathParam(c, 'id'));
      return c.json(await setHeart(heartDeps, viewer!.player, sign, true));
    },

    async unheartSign(c, { data, viewer }) {
      const key = pathParam(c, 'id');
      // A heart given before the sign was hidden, or its poster blocked, can still be taken back.
      const mine = await store.listHearts(viewer!.player.id);
      const sign =
        (await store.allSigns()).find((s) => (s.id === key || s.slug === key) && mine.some((h) => h.signId === s.id)) ??
        findSign((await data()).signs, key);
      return c.json(await setHeart(heartDeps, viewer!.player, sign, false));
    },

    async countAppViews(c) {
      const paths = appViews(await jsonBody(c));
      const now = nowSeconds();
      const later = 'Too many views for now. Try again in an hour.';
      await limit(store, `views:${network(clientIp(c))}`, LIMITS.viewBatchesAnHour, 3600, now, later);
      await limit(store, 'views-all', LIMITS.viewBatchesAllAnHour, 3600, now, later);
      if (tinylytics) {
        const userAgent = c.req.header('user-agent')?.slice(0, 512) || undefined;
        const country = viewerCountry(c);
        const hits: Hit[] = paths.map((path) => ({ path, userAgent, country }));
        // Awaited, briefly: work after the answer may never run on the platform.
        await tinylytics.addHits(hits).catch((err: unknown) => {
          if (!(err instanceof TinylyticsUnavailable)) throw err;
          if (!err.off)
            console.error({ event: 'tinylytics', op: 'views', outcome: 'unavailable', detail: err.message });
        });
      }
      return c.json({ accepted: paths.length }, 202);
    },

    async reportSign(c, { data, viewer }) {
      const sign = findSign((await data()).signs, pathParam(c, 'id'));
      const report = await reportSign(deps, viewer!.player, sign, await jsonBody(c));
      return c.json({ outcome: report.outcome, note: report.note });
    },

    async blockPlayer(c, { viewer }) {
      await blockPlayer(store, viewer!.player, pathParam(c, 'handle'));
      return c.body(null, 204);
    },

    async unblockPlayer(c, { viewer }) {
      await unblockPlayer(store, viewer!.player, pathParam(c, 'handle'));
      return c.body(null, 204);
    }
  };

  api.use('*', async (c, next) => {
    await next();
    c.header('API-Version', API_VERSION);
    const personal = c.req.header('authorization') !== undefined;
    if (c.req.method === 'GET' && c.res.status === 200 && !personal) c.header('Cache-Control', 'public, max-age=60');
    else c.header('Cache-Control', 'no-store');
  });

  for (const route of ROUTES) {
    const handler = handlers[route.operationId];
    if (!handler) throw new Error(`No handler for ${route.operationId}`);
    const path = route.path.replace(/\{(\w+)\}/g, ':$1') || '/';
    api.on(route.method.toUpperCase(), path, async (c) => {
      const viewer = await viewerFor(store, c.req.header('authorization'));
      if (route.auth === 'signed_in' && !viewer) fail('unauthorized', 'Sign in first');
      let loaded: Promise<Data> | undefined;
      let hearts: Promise<HeartView> | undefined;
      return handler(c, {
        data: () => (loaded ??= load(viewer)),
        hearts: () => (hearts ??= heartView(heartDeps, viewer?.player.id)),
        viewer
      });
    });
  }

  api.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, STATUS[err.code]);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something broke on the server' } }, 500);
  });

  return api;
}

/** The whole server: the API under /api/v1 and the website's pages beside it. */
export function createApp(options: ApiOptions): Hono {
  const app = new Hono();
  app.route('/api/v1', createApi(options));
  if (options.appleTeamId) {
    const association = JSON.stringify(appSiteAssociation(options.appleTeamId));
    const serve = (c: Context) =>
      c.body(association, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    app.get('/.well-known/apple-app-site-association', serve);
    app.get('/apple-app-site-association', serve);
  }
  app.route('/', createSite(options));
  app.notFound((c) => {
    if (!c.req.path.startsWith('/api/')) return c.text('Not found', 404);
    c.header('API-Version', API_VERSION);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'not_found', message: 'No such route' } }, 404);
  });
  return app;
}
