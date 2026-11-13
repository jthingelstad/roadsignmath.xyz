// Reports from the website (wave 2, package 2C), on the signed-in side (src/web/account.tsx): there
// only while `SITE_SIGNIN_OPEN`, never cached, every POST from the site's own Origin, no GET
// changes anything.
//
// The sign and player pages are cached for everyone, so their links are plain and the same for every
// reader: Report this sign and Report a duplicate on a sign's page, Report this player on a player's.
// The forms are here, under `/you/report/`:
//
// - `/you/report/sign/<slug>`: the app's report (`reportSign`): the moderator looks again with the
//   reason ("Inappropriate", and the note when there is one, as the app sends it) and hides the sign
//   if it agrees. One per player per sign; a second answers with the first.
// - `/you/report/duplicate/<slug>`: the app's "Report a duplicate" (`reportDuplicate`): the other
//   sign picked from the similar signs (src/posting/similar.ts) or named by its address. Only kept.
// - `/you/report/player/<handle>`: the app's report of a player (`reportPlayer`), emailed to the
//   owner. One per player; nothing is hidden.
//
// Each POST goes on to the same path with `/done`, which says what became of it. Every route asks
// who is signed in before anything else: signed out, a form goes straight to sign in and comes back
// (`reportBackTo`, the allowlist the sign-in's `to` takes), reading nothing but the session, and a
// key that isn't slug-shaped is a 404 before any read. A sign or player with no page here is a 404,
// as the page is. Reports, their limits, their emails to the
// owner and their product lines (marked `front: 'site'`) are the app's, not copies.

import type { Context, Hono } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { LIMITS } from '../api/contract.ts';
import { ApiError } from '../api/errors.ts';
import { isPublic, photoUrl, playerPath, signPath, type Urls } from '../api/views.ts';
import type { Player, Sign } from '../domain/types.ts';
import { reportDuplicate, reportPlayer, reportSign } from '../posting/posting.ts';
import { similarSigns } from '../posting/similar.ts';
import { sentence, trouble, type Status } from '../quiz/account.tsx';
import { FORM_STYLE, FormError, SITE_PATHS, invalidField } from '../quiz/pages.tsx';
import { sessionViewer, type Jar } from '../quiz/session.ts';
import { mailDuplicate, mailPlayerReport, mailReport } from '../reports.ts';
import { Page } from './layout.tsx';
import { Facts } from './cards.tsx';
import { playerByKey, signByKey } from './permalinks.ts';
import { hasPlayerPage } from './site.tsx';

export const REPORT_PATH = '/you/report';

export type ReportKind = 'sign' | 'duplicate' | 'player';

/** A sign's slug or a player's handle, as their addresses have them. */
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_MAX = 80;

/** The form for reporting a sign, a duplicate or a player: `/you/report/<kind>/<slug or handle>`. */
export const reportPath = (kind: ReportKind, key: string): string => `${REPORT_PATH}/${kind}/${key}`;

/**
 * A report form to come back to after signing in, or undefined: only the three forms' own paths,
 * with a key of a slug's or handle's shape, so `to` can never lead anywhere else.
 */
export function reportBackTo(raw: string | undefined): string | undefined {
  const m = raw ? /^\/you\/report\/(sign|duplicate|player)\/([^/]+)$/.exec(raw) : null;
  return m && m[2]!.length <= KEY_MAX && KEY.test(m[2]!) ? raw : undefined;
}

/** The reason the app sends: "Inappropriate", or "Inappropriate: " and the note. */
export const reportReason = (note: string): string => (note ? `Inappropriate: ${note}` : 'Inappropriate');

/** The longest note a sign or player report takes after "Inappropriate: " (the app's `reportNoteMax`). */
export const REPORT_NOTE_MAX = LIMITS.reportMax - 'Inappropriate: '.length;

/** How many similar signs "Report a duplicate" offers (the app's `DuplicateSheet.most`). */
const CHOICES = 12;

type ReportFront = {
  options: ApiOptions;
  jar: Jar;
  /** Draws a page as the signed-in side's answer (never cached). */
  page: (c: Context, body: Child, status?: Status) => Promise<Response>;
  /** Quiz's address while it is open, for the header. */
  quiz?: string;
};

type Body = Record<string, string | File | (string | File)[]>;

const one = (body: Body, name: string): string => {
  const v = body[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : '';
};

/** A note as the server keeps text: trimmed, each run of spaces one space. */
const tidy = (raw: string) => raw.trim().replace(/\s+/g, ' ');

/**
 * The sign a typed address or name names: a page's address (with or without the site, the
 * `/signs/` part or not), a slug or id, or a title only one sign has.
 */
export function signNamed(signs: readonly Sign[], raw: string): Sign | undefined {
  const typed = raw.trim();
  if (!typed) return undefined;
  let key = typed;
  if (/^https?:\/\//i.test(key)) {
    try {
      key = new URL(key).pathname;
    } catch {
      return undefined;
    }
  }
  key = key.replace(/^.*\/signs\//, '').replace(/[/?#].*$/, '');
  const found = key ? signByKey(signs, key)?.found : undefined;
  if (found) return found;
  const titled = signs.filter((s) => s.title.toLowerCase() === typed.toLowerCase());
  return titled.length === 1 ? titled[0] : undefined;
}

/** Mounts the three report forms on the signed-in side. */
export function mountReports(app: Hono, { options, jar, page, quiz }: ReportFront): void {
  const { store, urls } = options;
  const deps = { store, photos: options.photos, moderator: options.moderator, tinylytics: options.tinylytics };
  // Reports go where the app's go: to FEEDBACK_TO, best-effort (src/reports.ts).
  const mail = { store, mailer: options.mailer, urls, to: options.feedbackTo };
  const go = (c: Context, path: string) => c.redirect(path, 303);

  /**
   * The player, or a redirect to sign in (or to give a name first) and back to the form. Asked first
   * on every route, so a signed-out visitor costs one session read and nothing more.
   */
  async function reporter(c: Context, kind: ReportKind): Promise<Player | Response> {
    const back = reportPath(kind, c.req.param('key') ?? '');
    const viewer = await sessionViewer(store, c, jar);
    if (!viewer) return go(c, `${SITE_PATHS.signin}?to=${encodeURIComponent(back)}`);
    if (!viewer.player.name) return go(c, `${SITE_PATHS.name}?to=${encodeURIComponent(back)}`);
    return viewer.player;
  }

  /** Who blocked nobody (signed out), or the players this one blocked. */
  const blockedBy = async (player: Player | undefined) =>
    new Set(player ? (await store.listBlocks(player.id)).map((b) => b.blockedId) : []);

  /**
   * The sign a form is for, by its slug, when its page answers for this reader (shown, and not
   * posted by a player they blocked), else undefined.
   */
  async function shownSign(key: string, player: Player | undefined): Promise<Sign | undefined> {
    if (!KEY.test(key) || key.length > KEY_MAX) return undefined;
    const sign = (await store.allSigns()).find((s) => s.slug === key);
    if (!sign || !isPublic(sign)) return undefined;
    return (await blockedBy(player)).has(sign.postedBy) ? undefined : sign;
  }

  /** The signs a duplicate can name: shown, less those of players this one blocked. */
  async function others(player: Player): Promise<Sign[]> {
    const [signs, blocked] = await Promise.all([store.allSigns(), blockedBy(player)]);
    return signs.filter((s) => isPublic(s) && !blocked.has(s.postedBy));
  }

  /** The signs near this one that share at least half its numbers, nearest first (the posting form's lookup). */
  async function similarTo(player: Player, sign: Sign) {
    const { lat, lng } = sign.place;
    if (lat === undefined || lng === undefined || !sign.numbers.length) return [];
    const near = similarSigns(
      (await others(player)).filter((s) => s.id !== sign.id),
      lat,
      lng,
      sign.numbers.map((n) => n.value)
    );
    return near.slice(0, CHOICES);
  }

  /** The player a form is for, by handle, when their page answers, else undefined. */
  async function pagedPlayer(key: string): Promise<Player | undefined> {
    const named = playerByKey(await store.allPlayers(), key);
    if (!named?.canonical) return undefined;
    const shown = (await store.allSigns()).filter(isPublic);
    return (await hasPlayerPage(store, named.found, shown)) ? named.found : undefined;
  }

  /** A key of a slug's or handle's shape, else undefined (a 404 before anything is read). */
  const keyOf = (c: Context) => {
    const key = c.req.param('key') ?? '';
    return KEY.test(key) && key.length <= KEY_MAX ? key : undefined;
  };

  // ---- Report this sign

  /**
   * The sign a sign report is about: one whose page answers, or one this player already reported
   * (it may have come down since, and they see what became of it).
   */
  async function reportedSign(key: string, player: Player) {
    const sign = await shownSign(key, player);
    if (sign) return { sign, earlier: await store.getReport(sign.id, player.id) };
    const any = (await store.allSigns()).find((s) => s.slug === key);
    const earlier = any ? await store.getReport(any.id, player.id) : undefined;
    return earlier ? { sign: any, earlier } : { sign: undefined, earlier: undefined };
  }

  app.get(`${REPORT_PATH}/sign/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'sign');
    if (who instanceof Response) return who;
    const { sign, earlier } = await reportedSign(key, who);
    if (!sign) return c.notFound();
    if (earlier) return page(c, <SignReported sign={sign} outcome={earlier} site={urls.site} quiz={quiz} already />);
    return page(c, <SignReportPage sign={sign} urls={urls} quiz={quiz} yours={sign.postedBy === who.id} />);
  });

  app.post(`${REPORT_PATH}/sign/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'sign');
    if (who instanceof Response) return who;
    const { sign, earlier } = await reportedSign(key, who);
    if (!sign) return c.notFound();
    if (earlier) return go(c, `${reportPath('sign', key)}/done`);
    const note = tidy(one((await c.req.parseBody()) as Body, 'note'));
    try {
      if (note.length > REPORT_NOTE_MAX)
        throw new ApiError('bad_request', `Your note is at most ${REPORT_NOTE_MAX} characters`);
      // The app's report: the moderator looks again, and the owner gets an email of it.
      await reportSign(
        deps,
        who,
        sign,
        { reason: reportReason(note) },
        (saved, fresh) => mailReport(mail, who, fresh, saved),
        'site'
      );
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited', 'conflict', 'unavailable']);
      const error = sentence((err as ApiError).message);
      return page(
        c,
        <SignReportPage
          sign={sign}
          urls={urls}
          quiz={quiz}
          yours={sign.postedBy === who.id}
          note={note}
          error={error}
        />,
        status
      );
    }
    return go(c, `${reportPath('sign', key)}/done`);
  });

  app.get(`${REPORT_PATH}/sign/:key/done`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'sign');
    if (who instanceof Response) return who;
    const { sign, earlier } = await reportedSign(key, who);
    if (!sign) return c.notFound();
    if (!earlier) return go(c, reportPath('sign', key));
    return page(c, <SignReported sign={sign} outcome={earlier} site={urls.site} quiz={quiz} />);
  });

  // ---- Report a duplicate

  app.get(`${REPORT_PATH}/duplicate/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'duplicate');
    if (who instanceof Response) return who;
    const sign = await shownSign(key, who);
    if (!sign) return c.notFound();
    const choices = await similarTo(who, sign);
    return page(c, <DuplicatePage sign={sign} urls={urls} quiz={quiz} choices={choices} />);
  });

  app.post(`${REPORT_PATH}/duplicate/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'duplicate');
    if (who instanceof Response) return who;
    const sign = await shownSign(key, who);
    if (!sign) return c.notFound();
    const body = (await c.req.parseBody()) as Body;
    const typed = one(body, 'other').trim();
    const picked = one(body, 'same_as');
    const note = tidy(one(body, 'note'));
    const choices = await similarTo(who, sign);
    try {
      const signs = await others(who);
      const other = typed ? signNamed(signs, typed) : picked ? signNamed(signs, picked) : undefined;
      if (!other) {
        throw new ApiError(
          'bad_request',
          typed || picked
            ? 'No sign has that address or name. Check it and try again.'
            : 'Pick the sign it’s the same as, or give its address.'
        );
      }
      // The app's duplicate report: only kept, and the owner gets an email of it.
      await reportDuplicate(store, who, sign, other, { same_as: other.slug, note }, 'site', (kept) =>
        mailDuplicate(mail, who, sign, other, kept)
      );
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited']);
      const error = sentence((err as ApiError).message.replace(/^note is/, 'Your note is'));
      return page(
        c,
        <DuplicatePage
          sign={sign}
          urls={urls}
          quiz={quiz}
          choices={choices}
          picked={picked}
          typed={typed}
          note={note}
          error={error}
        />,
        status
      );
    }
    return go(c, `${reportPath('duplicate', key)}/done`);
  });

  app.get(`${REPORT_PATH}/duplicate/:key/done`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'duplicate');
    if (who instanceof Response) return who;
    const sign = await shownSign(key, who);
    if (!sign) return c.notFound();
    if (!(await store.getDuplicate(sign.id, who.id))) return go(c, reportPath('duplicate', key));
    return page(c, <DuplicateNoted sign={sign} quiz={quiz} />);
  });

  // ---- Report this player

  app.get(`${REPORT_PATH}/player/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'player');
    if (who instanceof Response) return who;
    const player = await pagedPlayer(key);
    if (!player) return c.notFound();
    if (await store.getPlayerReport(player.id, who.id)) {
      return page(c, <PlayerReported player={player} quiz={quiz} already />);
    }
    return page(c, <PlayerReportPage player={player} quiz={quiz} yourself={player.id === who.id} />);
  });

  app.post(`${REPORT_PATH}/player/:key`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'player');
    if (who instanceof Response) return who;
    const player = await pagedPlayer(key);
    if (!player) return c.notFound();
    const note = tidy(one((await c.req.parseBody()) as Body, 'note'));
    try {
      if (note.length > REPORT_NOTE_MAX)
        throw new ApiError('bad_request', `Your note is at most ${REPORT_NOTE_MAX} characters`);
      // The app's report of a player: emailed to the owner, nothing hidden; a repeat changes nothing.
      await reportPlayer(
        store,
        who,
        player.handle,
        { reason: reportReason(note) },
        (saved, reported) => mailPlayerReport(mail, who, reported, saved),
        'site'
      );
    } catch (err) {
      const status = trouble(err, ['bad_request', 'rate_limited']);
      const error = sentence((err as ApiError).message);
      return page(
        c,
        <PlayerReportPage player={player} quiz={quiz} yourself={player.id === who.id} note={note} error={error} />,
        status
      );
    }
    return go(c, `${reportPath('player', key)}/done`);
  });

  app.get(`${REPORT_PATH}/player/:key/done`, async (c) => {
    const key = keyOf(c);
    if (!key) return c.notFound();
    const who = await reporter(c, 'player');
    if (who instanceof Response) return who;
    const player = await pagedPlayer(key);
    if (!player) return c.notFound();
    if (!(await store.getPlayerReport(player.id, who.id))) return go(c, reportPath('player', key));
    return page(c, <PlayerReported player={player} quiz={quiz} />);
  });
}

// ---------------------------------------------------------------------------------------------
// Pages

const REPORT_STYLE = `
.acct .report { max-width: 560px; }
.acct .back { align-self: flex-start; min-height: 44px; padding: 0; }
.acct .about { display: flex; gap: 12px; align-items: center; }
.acct .about img, .acct .about .noimg { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; background: var(--photo);
  flex: 0 0 auto; }
.acct .about .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acct .about strong { font-weight: 900; overflow-wrap: anywhere; }
.acct textarea.field { min-height: 110px; resize: vertical; }
.acct .btn.warn { background: var(--bad); color: var(--card); }
.acct fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.acct legend { padding: 0; margin-bottom: 4px; font-weight: 800; }
.acct .pick { display: flex; gap: 12px; align-items: center; padding: 10px; border-radius: 12px; border: 1.5px solid var(--line);
  background: var(--card); cursor: pointer; font-weight: 400; }
.acct .pick:has(input:checked) { border-color: var(--green-ink); box-shadow: 0 0 0 1px var(--green-ink); }
.acct .pick:focus-within { outline: 3px solid var(--green-ink); outline-offset: 2px; }
.acct .pick input { width: 22px; height: 22px; flex: 0 0 auto; accent-color: var(--green-ink); }
.acct .pick img, .acct .pick .noimg { width: 56px; height: 56px; object-fit: cover; border-radius: 10px; background: var(--photo);
  flex: 0 0 auto; }
.acct .pick .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acct .pick strong { font-weight: 900; overflow-wrap: anywhere; }
.acct .said-note { padding: 14px; border-radius: 12px; border: 1px solid var(--rule); background: var(--card); display: flex;
  flex-direction: column; gap: 4px; margin: 0; }
.acct .said-note b { font-size: 14px; color: var(--soft); }
`;

const ReportFrame: FC<PropsWithChildren<{ title: string; quiz?: string }>> = ({ title, quiz, children }) => (
  <Page
    title={`${title} · Road Sign Math`}
    description="Report something on Road Sign Math."
    quiz={quiz}
    banner={false}
    count={false}
    style={FORM_STYLE + REPORT_STYLE}
  >
    <main id="main" class="wrap acct">
      <div class="stack report">{children}</div>
    </main>
  </Page>
);

/** A report form's error, focused when the page is drawn with it (the field it is about, if any, instead). */
const Oops: FC<{ error?: string; onField?: boolean }> = ({ error, onField }) => (
  <FormError error={error} onField={onField} />
);

/** Whether a report form's error is about its note. */
const aboutNote = (error?: string) => !!error && /^Your note/.test(error);

/** Whether a duplicate report's error is about the other sign's address. */
const aboutOther = (error?: string) => !!error && /^No sign has that address/.test(error);

/** The sign a report is about: its first photo, title and place, linked to its page while it is shown. */
const AboutSign: FC<{ sign: Sign; site: string }> = ({ sign, site }) => {
  const photo = sign.photos[0];
  return (
    <div class="about">
      {photo && isPublic(sign) ? <img src={photoUrl({ site }, photo.id, 'thumb')} alt="" /> : <span class="noimg" />}
      <div class="what">
        {isPublic(sign) ? <a href={signPath(sign)}>{sign.title}</a> : <strong>{sign.title}</strong>}
        <span class="meta">{sign.place.label}</span>
      </div>
    </div>
  );
};

/** "Anything to add?", the app's optional note. */
const NoteField: FC<{ note?: string; max: number; bad?: boolean }> = ({ note, max, bad }) => (
  <>
    <label for="note">Anything to add?</label>
    <textarea id="note" name="note" class="field" maxlength={max} placeholder="Optional" {...invalidField(bad)}>
      {note ?? ''}
    </textarea>
  </>
);

const SignReportPage: FC<{ sign: Sign; urls: Urls; quiz?: string; yours: boolean; note?: string; error?: string }> = ({
  sign,
  urls,
  quiz,
  yours,
  note,
  error
}) => (
  <ReportFrame title="Report this sign" quiz={quiz}>
    <h1>Report this sign</h1>
    <AboutSign sign={sign} site={urls.site} />
    {yours ? (
      <>
        <Oops error="You can’t report your own sign." />
        <a class="btn ghost" href={signPath(sign)}>
          Done
        </a>
      </>
    ) : (
      <form method="post" action={reportPath('sign', sign.slug)} class="stack">
        <p class="lede">
          Is this sign inappropriate? The moderator takes another look, and if it agrees, the sign comes down for
          everyone.
        </p>
        <NoteField note={note} max={REPORT_NOTE_MAX} bad={aboutNote(error)} />
        <Oops error={error} onField={aboutNote(error)} />
        <button class="btn warn" type="submit">
          Report as inappropriate
        </button>
        <a class="btn ghost" href={signPath(sign)}>
          Cancel
        </a>
      </form>
    )}
  </ReportFrame>
);

/** What the moderator decided, in the app's words. */
const SignReported: FC<{
  sign: Sign;
  outcome: { outcome: 'hidden' | 'kept'; note: string };
  site: string;
  quiz?: string;
  already?: boolean;
}> = ({ sign, outcome, site, quiz, already }) => {
  const down = outcome.outcome === 'hidden';
  return (
    <ReportFrame title={down ? 'It’s down' : 'It stays up'} quiz={quiz}>
      <AboutSign sign={sign} site={site} />
      {already && <p class="meta">You reported this sign already.</p>}
      <h1>{down ? 'It’s down' : 'It stays up'}</h1>
      <p class="lede">
        {down
          ? 'Thanks for telling us. It’s off the feed, the map and the website.'
          : 'The moderator looked again and kept it. Thanks for telling us.'}
      </p>
      {outcome.note && (
        <p class="said-note">
          <b>The moderator’s note</b>
          <span>{outcome.note}</span>
        </p>
      )}
      <a class="btn ghost" href={isPublic(sign) ? signPath(sign) : '/'}>
        Done
      </a>
    </ReportFrame>
  );
};

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "0.4 mi away", "found by Ada", "Jan 2026": the facts the app's duplicate sheet gives each sign. */
export function whereWords(sign: Sign, miles: number): string[] {
  const away = miles < 0.05 ? 'Right here' : `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi away`;
  const who = sign.finders.map((f) => f.name).join(', ');
  const month = MONTH.format(new Date(`${sign.foundOn}T00:00:00Z`));
  return [away, who && `found by ${who}`, month].filter(Boolean);
}

const DuplicatePage: FC<{
  sign: Sign;
  urls: Urls;
  quiz?: string;
  choices: { sign: Sign; miles: number }[];
  picked?: string;
  typed?: string;
  note?: string;
  error?: string;
}> = ({ sign, urls, quiz, choices, picked, typed, note, error }) => (
  <ReportFrame title="Report a duplicate" quiz={quiz}>
    <h1>Report a duplicate</h1>
    <AboutSign sign={sign} site={urls.site} />
    <form method="post" action={reportPath('duplicate', sign.slug)} class="stack">
      <p class="lede">
        Is this the same road sign as one posted before? Pick that one. Neither sign changes; your report is kept for
        later.
      </p>
      {choices.length > 0 ? (
        <fieldset>
          <legend>The same sign as</legend>
          {choices.map(({ sign: other, miles }) => (
            <label class="pick">
              <input type="radio" name="same_as" value={other.slug} checked={picked === other.slug} />
              {other.photos[0] ? (
                <img src={photoUrl(urls, other.photos[0].id, 'thumb')} alt="" loading="lazy" />
              ) : (
                <span class="noimg" />
              )}
              <span class="what">
                <strong>{other.title}</strong>
                <span class="meta">
                  <Facts items={whereWords(other, miles)} />
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        sign.place.lat === undefined && (
          <p class="meta">This sign has no pin on the map, so there are no signs near it to choose from.</p>
        )
      )}
      <label for="other">{choices.length > 0 ? 'Or its address' : 'Its address'}</label>
      <input
        id="other"
        name="other"
        class="field"
        type="text"
        inputmode="url"
        autocomplete="off"
        spellcheck={false}
        value={typed ?? ''}
        aria-describedby={aboutOther(error) ? 'form-error other-hint' : 'other-hint'}
        aria-invalid={aboutOther(error) ? 'true' : undefined}
        autofocus={aboutOther(error) ? true : undefined}
      />
      <p class="meta" id="other-hint">
        The other sign’s page, like roadsignmath.xyz/signs/its-name, or its name as it is in that address.
      </p>
      <NoteField note={note} max={LIMITS.reportMax} bad={aboutNote(error)} />
      <Oops error={error} onField={aboutNote(error) || aboutOther(error)} />
      <button class="btn" type="submit">
        Report as a duplicate
      </button>
      <a class="btn ghost" href={signPath(sign)}>
        Cancel
      </a>
    </form>
  </ReportFrame>
);

const DuplicateNoted: FC<{ sign: Sign; quiz?: string }> = ({ sign, quiz }) => (
  <ReportFrame title="Thanks, it’s noted" quiz={quiz}>
    <h1>Thanks, it’s noted</h1>
    <p class="lede">Both signs stay as they are. Your report is kept for later.</p>
    <a class="btn ghost" href={signPath(sign)}>
      Done
    </a>
  </ReportFrame>
);

const PlayerReportPage: FC<{ player: Player; quiz?: string; yourself: boolean; note?: string; error?: string }> = ({
  player,
  quiz,
  yourself,
  note,
  error
}) => (
  <ReportFrame title="Report this player" quiz={quiz}>
    <h1>Report this player</h1>
    {yourself ? (
      <>
        <Oops error="You can’t report yourself." />
        <a class="btn ghost" href={playerPath(player)}>
          Done
        </a>
      </>
    ) : (
      <form method="post" action={reportPath('player', player.handle)} class="stack">
        <p class="lede">
          Is something on <a href={playerPath(player)}>{player.name}’s page</a> inappropriate? Your report goes to
          Jamie, who runs Road Sign Math, with your name. Nothing comes down on its own.
        </p>
        <NoteField note={note} max={REPORT_NOTE_MAX} bad={aboutNote(error)} />
        <Oops error={error} onField={aboutNote(error)} />
        <button class="btn warn" type="submit">
          Report as inappropriate
        </button>
        <a class="btn ghost" href={playerPath(player)}>
          Cancel
        </a>
      </form>
    )}
  </ReportFrame>
);

const PlayerReported: FC<{ player: Player; quiz?: string; already?: boolean }> = ({ player, quiz, already }) => (
  <ReportFrame title="Report sent" quiz={quiz}>
    {already && <p class="meta">You reported {player.name} already.</p>}
    <h1>Report sent</h1>
    <p class="lede">Thanks for telling us. It’s on its way to Jamie.</p>
    <a class="btn ghost" href={playerPath(player)}>
      Done
    </a>
  </ReportFrame>
);
