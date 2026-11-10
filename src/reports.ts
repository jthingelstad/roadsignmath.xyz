// Reports reach Jamie: each new report of a sign, and each "Report a duplicate", is emailed to
// FEEDBACK_TO, the address Send feedback uses (Jamie, 2026-11-10: "an email to
// admin@thingelstad.com for each report (Claude's verdict and the sign's link, the Send feedback
// route)"). The email carries the sign's title and link, the reason or note, Claude's verdict for
// a report, and the reporter's name and handle, which are public. Never an email address.
//
// Best-effort: the report is already decided and saved when the email goes, so a mail that
// can't be sent changes nothing a player sees. It is logged by outcome only.

import { signUrl, type Urls } from './api/views.ts';
import type { DuplicateReport, Player, Report, Sign } from './domain/types.ts';
import type { Mail, Mailer } from './mail/mailer.ts';
import type { Store } from './store/store.ts';

export type ReportMailDeps = {
  store: Store;
  mailer: Mailer;
  urls: Urls;
  /** FEEDBACK_TO; without it no report is emailed. */
  to?: string;
};

export type ReportMailOutcome = 'sent' | 'unsent' | 'off';

const central = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});

/** "Ada Lovelace (@ada)", or "@p0123…" for a player with no name yet. */
const who = (player: Player | undefined): string =>
  !player ? 'a player no longer here' : player.name ? `${player.name} (@${player.handle})` : `@${player.handle}`;

/** The owner's commands for the sign, ready to paste on the Mac (tools/owner.ts). */
const commands = (sign: Sign): string[] => [
  `Hide it: npm run owner -- hide-sign ${sign.slug} --to check`,
  `Show it again: npm run owner -- unhide-sign ${sign.slug} --to check`
];

/** The email for a report Claude has just looked at. */
export function reportMail(
  to: string,
  urls: Urls,
  reporter: Player,
  sign: Sign,
  poster: Player | undefined,
  report: Report
): Mail {
  const hidden = report.outcome === 'hidden';
  const lines = [
    `${who(reporter)} reported “${sign.title}”.`,
    signUrl(urls, sign),
    '',
    `Reason: ${report.reason}`,
    '',
    hidden ? 'Claude hid it.' : 'Claude kept it.',
    `Claude’s note: ${report.note}`,
    '',
    '—',
    `Sign: ${sign.slug}, posted by ${who(poster)}, now ${hidden ? 'hidden' : sign.visibility}`,
    `Sent: ${central.format(new Date(report.createdAt))}`,
    ...commands(sign)
  ];
  return {
    to,
    subject: `Road Sign Math report: ${sign.title} (${hidden ? 'hidden' : 'kept'})`,
    text: `${lines.join('\n')}\n`
  };
}

/** The email for a player's word that two signs are the same road sign. */
export function duplicateMail(
  to: string,
  urls: Urls,
  reporter: Player,
  sign: Sign,
  other: Sign,
  report: DuplicateReport
): Mail {
  const lines = [
    `${who(reporter)} says “${sign.title}” is a duplicate of “${other.title}”.`,
    `This one: ${signUrl(urls, sign)}`,
    `Same as: ${signUrl(urls, other)}`,
    '',
    `Note: ${report.note ?? 'none'}`,
    '',
    'A duplicate report is only kept: Claude doesn’t look at it, and nothing is hidden.',
    '',
    '—',
    `Signs: ${sign.slug} and ${other.slug}`,
    `Sent: ${central.format(new Date(report.createdAt))}`,
    ...commands(sign)
  ];
  return {
    to,
    subject: `Road Sign Math duplicate: ${sign.title}`,
    text: `${lines.join('\n')}\n`
  };
}

/** Sends a mail best-effort: never throws, and logs only the outcome. */
async function deliver(deps: ReportMailDeps, kind: string, make: (to: string) => Promise<Mail>) {
  let outcome: ReportMailOutcome = 'off';
  if (deps.to) {
    const to = deps.to;
    try {
      await deps.mailer.send(await make(to));
      outcome = 'sent';
    } catch {
      outcome = 'unsent';
    }
  }
  console.info({ event: 'report-mail', kind, outcome });
  return outcome;
}

/** Emails a new report to the owner. Never throws. */
export function mailReport(
  deps: ReportMailDeps,
  reporter: Player,
  sign: Sign,
  report: Report
): Promise<ReportMailOutcome> {
  return deliver(deps, 'report', async (to) => {
    const poster = await deps.store.getPlayer(sign.postedBy).catch(() => undefined);
    return reportMail(to, deps.urls, reporter, sign, poster ?? undefined, report);
  });
}

/** Emails a duplicate report to the owner. Never throws. */
export function mailDuplicate(
  deps: ReportMailDeps,
  reporter: Player,
  sign: Sign,
  other: Sign,
  report: DuplicateReport
): Promise<ReportMailOutcome> {
  return deliver(deps, 'duplicate', async (to) => duplicateMail(to, deps.urls, reporter, sign, other, report));
}
