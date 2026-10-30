// Sign-in by email: a link that opens the app, and a 6-digit code to type when the link can't.
// Anyone can sign up; the first sign-in with an address makes the player. The app keeps a
// bearer token, `rsm_<playerId>_<secret>`, until it signs out; only the secret's hash is stored.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fail } from '../api/errors.ts';
import { ulid } from '../domain/ids.ts';
import { AVATAR_COLORS, type Login, type Player, type Session } from '../domain/types.ts';
import type { Mailer } from '../mail/mailer.ts';
import { emailHash, normalizeEmail, nowSeconds, type Store } from '../store/store.ts';

export const LOGIN_TTL = 15 * 60;
export const MAX_CODE_ATTEMPTS = 5;
/** A token unused this long ends. Using it pushes the end back, at most once a day. */
export const SESSION_IDLE = 180 * 86400;
export const SESSION_TOUCH = 86400;

/** Sign-in emails an hour: to one address, from one network, and in all. Wrong codes a day per address. */
export const LIMITS = { address: 5, network: 20, total: 200, wrongCodesADay: 20 } as const;

const HOUR = 3600;
const DAY = 86400;
const TOKEN = /^rsm_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A plausible address, normalized, or undefined. */
export function validEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = normalizeEmail(raw);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/** The network a request came from: the IPv4 address, or an IPv6 /64. */
export function network(ip: string): string {
  if (!ip.includes(':')) return ip;
  const groups = ip.split('::')[0].split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

async function limit(store: Store, key: string, max: number, seconds: number, now: number, message: string) {
  if ((await store.bump(key, seconds, now)) > max) fail('rate_limited', message);
}

export type SignInLink = (loginId: string, token: string) => string;

/** Sends the link and code. The answer is the same whether or not the address has an account. */
export async function startSignIn(
  deps: { store: Store; mailer: Mailer; link: SignInLink },
  rawEmail: unknown,
  ip: string
): Promise<{ loginId: string; expiresIn: number }> {
  const email = validEmail(rawEmail) ?? fail('bad_request', 'email must be an email address');
  const now = nowSeconds();
  const later = 'Too many sign-in emails for now. Try again in an hour.';
  await limit(deps.store, `address:${emailHash(email)}`, LIMITS.address, HOUR, now, later);
  await limit(deps.store, `network:${network(ip)}`, LIMITS.network, HOUR, now, later);
  await limit(deps.store, 'total', LIMITS.total, HOUR, now, later);

  const token = randomBytes(32).toString('base64url');
  const code = randomInt(1_000_000).toString().padStart(6, '0');
  const login: Login = {
    id: ulid(),
    email,
    tokenHash: sha256(token),
    codeHash: sha256(code),
    attempts: 0,
    createdAt: new Date(now * 1000).toISOString(),
    expiresAt: now + LOGIN_TTL
  };
  await deps.store.putLogin(login);
  await deps.mailer.send({
    to: email,
    subject: `Your Road Sign Math code is ${code}`,
    text:
      `Tap to sign in to Road Sign Math on your iPhone:\n${deps.link(login.id, token)}\n\n` +
      `Or type this code in the app: ${code}\n\n` +
      `It works for 15 minutes. If you didn't ask to sign in, you can ignore this email.\n`
  });
  return { loginId: login.id, expiresIn: LOGIN_TTL };
}

const randomHandle = (): string => `p${randomBytes(5).toString('hex')}`;

/** Checks the link token or the code and returns a new token, making the player on first sign-in. */
export async function finishSignIn(
  store: Store,
  input: { loginId?: unknown; code?: unknown; token?: unknown }
): Promise<{ token: string; player: Player; isNew: boolean }> {
  if (typeof input.loginId !== 'string') fail('bad_request', 'login_id is required');
  const hasCode = typeof input.code === 'string';
  const hasToken = typeof input.token === 'string';
  if (hasCode === hasToken) fail('bad_request', 'Send either code or token');
  if (hasCode && !/^\d{6}$/.test(input.code as string)) fail('bad_request', 'code is six digits');

  const expired = 'That sign-in has ended. Ask for a new code.';
  const login = (await store.getLogin(input.loginId as string)) ?? fail('unauthorized', expired);
  const now = nowSeconds();
  if (hasToken) {
    if (!same(sha256(input.token as string), login.tokenHash)) fail('unauthorized', expired);
  } else if (!same(sha256(input.code as string), login.codeHash)) {
    const wrongToday = await store.bump(`wrong:${emailHash(login.email)}`, DAY, now);
    login.attempts += 1;
    if (login.attempts >= MAX_CODE_ATTEMPTS || wrongToday > LIMITS.wrongCodesADay) {
      await store.deleteLogin(login.id);
      fail('unauthorized', 'Too many wrong codes. Ask for a new one.');
    }
    await store.putLogin(login);
    fail('unauthorized', "That code isn't right.");
  }
  await store.deleteLogin(login.id);

  const known = await store.playerIdForEmail(login.email);
  let player = known ? await store.getPlayer(known) : undefined;
  const isNew = !player;
  if (!player) {
    player = {
      id: ulid(),
      handle: randomHandle(),
      name: '',
      avatarColor: AVATAR_COLORS[randomInt(AVATAR_COLORS.length)],
      email: login.email,
      createdAt: new Date(now * 1000).toISOString()
    };
    await store.putPlayer(player);
  }
  const secret = randomBytes(32).toString('base64url');
  const at = new Date(now * 1000).toISOString();
  await store.putSession({
    playerId: player.id,
    secretHash: sha256(secret),
    createdAt: at,
    lastUsedAt: at,
    expiresAt: now + SESSION_IDLE
  });
  return { token: `rsm_${player.id}_${secret}`, player, isNew };
}

export type Viewer = { player: Player; session: Session };

/** The player behind an `Authorization: Bearer` header, or undefined when there's no header. */
export async function viewerFor(store: Store, header: string | undefined): Promise<Viewer | undefined> {
  if (!header) return undefined;
  const ended = 'That token has ended. Sign in again.';
  const match = /^Bearer (\S+)$/.exec(header)?.[1].match(TOKEN) ?? fail('unauthorized', ended);
  const [, playerId, secret] = match;
  const session = (await store.getSession(playerId, sha256(secret))) ?? fail('unauthorized', ended);
  const player = (await store.getPlayer(playerId)) ?? fail('unauthorized', ended);
  const now = nowSeconds();
  if (now - Date.parse(session.lastUsedAt) / 1000 > SESSION_TOUCH) {
    session.lastUsedAt = new Date(now * 1000).toISOString();
    session.expiresAt = now + SESSION_IDLE;
    await store.putSession(session);
  }
  return { player, session };
}

export async function signOut(store: Store, viewer: Viewer): Promise<void> {
  await store.deleteSession(viewer.player.id, viewer.session.secretHash);
}
