// Feedback from the app: a player's message, emailed to the address in the stack's
// FEEDBACK_TO (Jamie, 2026-10-31: "Route the inbound requests to admin@thingelstad.com").
// The player's email goes along only when they say a reply is fine, and then only as the
// Reply-To, never in the message.

import { LIMITS } from './api/contract.ts';
import { fail } from './api/errors.ts';
import { limit, text } from './api/input.ts';
import { playerUrl, type Urls } from './api/views.ts';
import type { Player } from './domain/types.ts';
import type { Mail, Mailer } from './mail/mailer.ts';
import type { Store } from './store/store.ts';

const DAY = 86400;
const CONTROL = /\p{Cc}/u;
const FIELDS = ['message', 'reply_ok', 'app'];

export type Feedback = { message: string; replyOk: boolean; app?: string };

export type FeedbackDeps = {
  store: Store;
  mailer: Mailer;
  urls: Urls;
  /** Where feedback goes; without it feedback answers 503. */
  to?: string;
};

const absent = (value: unknown): boolean => value === undefined || value === null;

/** The body of `POST /feedback`, checked. The message keeps its line breaks. */
export function feedbackBody(body: Record<string, unknown>): Feedback {
  const unknown = Object.keys(body).filter((k) => !FIELDS.includes(k));
  if (unknown.length) fail('bad_request', `The feedback has no ${unknown.join(', ')}`);
  if (typeof body.message !== 'string') return fail('bad_request', 'message must be text');
  const message = body.message.replace(/\r\n?/g, '\n').trim();
  if (CONTROL.test(message.replace(/[\n\t]/g, ' '))) fail('bad_request', 'message can’t hold control characters');
  if (message.length < 1 || message.length > LIMITS.feedbackMax) {
    fail('bad_request', `message is 1 to ${LIMITS.feedbackMax} characters`);
  }
  if (!absent(body.reply_ok) && typeof body.reply_ok !== 'boolean') fail('bad_request', 'reply_ok is true or false');
  const app = absent(body.app) ? '' : text(body.app, 'app', LIMITS.feedbackAppMax, 0);
  return { message, replyOk: body.reply_ok === true, ...(app ? { app } : {}) };
}

const central = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});

/** The email: the message first, then who sent it and from what, the time in US Central. */
export function feedbackMail(
  to: string,
  urls: Urls,
  player: Player,
  signCount: number,
  feedback: Feedback,
  at: Date
): Mail {
  const named = player.name !== '';
  const replyTo = feedback.replyOk && player.email ? player.email : undefined;
  const lines = [
    feedback.message,
    '',
    '—',
    `From: ${named ? player.name : 'a player with no name yet'} (@${player.handle})`,
    ...(named ? [`Page: ${playerUrl(urls, player)}`] : []),
    `Signs: ${signCount}`,
    `App: ${feedback.app ?? 'not given'}`,
    `Sent: ${central.format(at)}`,
    replyTo
      ? 'Reply: fine. Replying to this email goes to them.'
      : feedback.replyOk
        ? 'Reply: fine, but the account has no email address.'
        : 'Reply: not asked for. Their email address isn’t in this message.'
  ];
  return {
    to,
    subject: `Road Sign Math feedback from ${named ? player.name : 'a player'}`,
    text: `${lines.join('\n')}\n`,
    ...(replyTo ? { replyTo } : {})
  };
}

/**
 * Checks the body, counts one of the player's ten a day, and sends it. A send that fails is a
 * 503 with nothing sent; it still counts toward the day's ten, so a failing mailer can't be
 * hammered.
 */
export async function sendFeedback(
  deps: FeedbackDeps,
  player: Player,
  signCount: number,
  body: Record<string, unknown>,
  now: number
): Promise<void> {
  const feedback = feedbackBody(body);
  const unsent = 'Your feedback couldn’t be sent just now. Try again in a minute.';
  if (!deps.to) return fail('unavailable', unsent);
  const tomorrow = 'That’s all the feedback for today. Try again tomorrow.';
  await limit(deps.store, `feedback:${player.id}`, LIMITS.feedbackADay, DAY, now, tomorrow);
  const mail = feedbackMail(deps.to, deps.urls, player, signCount, feedback, new Date(now * 1000));
  try {
    await deps.mailer.send(mail);
  } catch (err) {
    console.error({ event: 'feedback', outcome: 'unsent', detail: err instanceof Error ? err.message : String(err) });
    fail('unavailable', unsent);
  }
  console.info({ event: 'feedback', outcome: 'sent', reply: !!mail.replyTo });
}
