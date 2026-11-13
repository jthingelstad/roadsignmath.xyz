// Posting a sign from the website (wave 2, package 2B), at `/post`, on the signed-in side
// (src/web/account.tsx): off with it until `SITE_SIGNIN_OPEN`, never cached, every POST from the
// site's own Origin.
//
// It is the app's posting with a form in front: the same upload (`uploadPhoto`), the same post
// (`postSign`, marked `front: 'site'` on its product line), the same similar-signs lookup, the same
// checker and Quiz's keypad, the same moderator and limits. Nothing here decides what a post may be.
//
// Two steps, one address. The details (photos, numbers, title, caption, day, who, place) are a form
// that posts back to `/post` with `go` saying what to do: add a photo, remove one, show another
// row, or go on to the math. The math step shows "Posted already?" from the similar-signs lookup,
// then Quiz's keypad, then "Post it unsolved". The whole draft rides in the form, so a step back
// loses nothing, and the idempotency key made when the form was first drawn rides with it, so a
// post sent twice makes one sign. `GET /post/done/<id>` says what became of it: posted, or held
// with the moderator's note.
//
// Without scripts every step works: one photo at a time, sent as it is (JPEG, PNG or WebP, at most
// 4 MB), the numbers and place typed, the math typed. The scripts (src/web/post-script.ts) add the
// in-browser resize, the photo's own place and day, the marks on the photo, the map pick, the
// keypad, and the draft kept in the browser.

import type { Context, Hono } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { LIMITS } from '../api/contract.ts';
import { ApiError } from '../api/errors.ts';
import { isPublic, photoUrl, signPath, visibleTo } from '../api/views.ts';
import { normalizeNumber } from '../domain/equation.ts';
import type { FinderRole, Player, Sign } from '../domain/types.ts';
import { US_STATES, postSign, readPost, uploadPhoto } from '../posting/posting.ts';
import { similarSigns } from '../posting/similar.ts';
import { sentence, trouble, type Status } from '../quiz/account.tsx';
import { CHECKER_JS } from '../quiz/checker.ts';
import { KEYPAD_JS } from '../quiz/keypad.ts';
import { FORM_STYLE, FormError, Keypad, SITE_PATHS, invalidField } from '../quiz/pages.tsx';
import type { Jar } from '../quiz/session.ts';
import { sessionViewer } from '../quiz/session.ts';
import { Page } from './layout.tsx';
import { EXIF_JS, POST_JS, doneJs, draftOwner } from './post-script.ts';

export const POST_PATH = '/post';

/** How many people besides the poster the form has room for (the server takes six finders in all). */
const PEOPLE = LIMITS.findersMax - 1;
/** Rows of numbers shown at first; more come one at a time, up to the server's most. */
const FIRST_ROWS = 3;
/** The largest request `/post` reads: a photo at the server's most, and the form around it. */
const MOST_BYTES = LIMITS.photoBytes + 512 * 1024;
const PHOTO_ID = /^[0-9a-z]{26}$/;
const NUMBER = /^\d*\.?\d+$|^\d+\.$/;

const ROLES: [FinderRole, string][] = [
  ['found', 'Found it'],
  ['took_photo', 'Took the photo'],
  ['spotted', 'Spotted it']
];

/** The form as it stands, read from the fields it posts. */
export type Draft = {
  key: string;
  photos: string[];
  rows: number;
  numbers: { value: string; text: string; box: string }[];
  title: string;
  caption: string;
  foundOn: string;
  role: FinderRole;
  people: { who: string; role: FinderRole }[];
  shownPeople: number;
  label: string;
  state: string;
  lat: string;
  lng: string;
  approximate: boolean;
};

/** Today in Minnesota, where the game lives: the day found a fresh form starts with. */
export const today = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);

const newKey = () => `web_${crypto.randomUUID().replace(/-/g, '')}`;

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(n) ? n : low));

const roleOf = (raw: string): FinderRole => (ROLES.some(([r]) => r === raw) ? (raw as FinderRole) : 'found');

/** A fresh form. */
export function freshDraft(): Draft {
  return {
    key: newKey(),
    photos: [],
    rows: FIRST_ROWS,
    numbers: Array.from({ length: LIMITS.numbersMax }, () => ({ value: '', text: '', box: '' })),
    title: '',
    caption: '',
    foundOn: today(),
    role: 'found',
    people: Array.from({ length: PEOPLE }, () => ({ who: '', role: 'found' as FinderRole })),
    shownPeople: 0,
    label: '',
    state: '',
    lat: '',
    lng: '',
    approximate: false
  };
}

type Body = Record<string, string | File | (string | File)[]>;

/** Reads the form's fields into a draft; anything missing or odd is left as a fresh form has it. */
export function readDraft(body: Body): Draft {
  const one = (name: string) => {
    const v = body[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' ? s : '';
  };
  const fresh = freshDraft();
  const key = one('key');
  const raw = body.photos;
  const photos = [
    ...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((p) => typeof p === 'string'))
  ]
    .filter((p) => PHOTO_ID.test(p as string))
    .slice(0, LIMITS.photosMax) as string[];
  return {
    key: /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : fresh.key,
    photos,
    rows: clamp(Number(one('rows')), 1, LIMITS.numbersMax),
    numbers: fresh.numbers.map((_, i) => ({
      value: one(`n${i}_value`).trim(),
      text: one(`n${i}_text`).trim(),
      box: one(`n${i}_box`).trim()
    })),
    title: one('title').trim(),
    caption: one('caption').trim(),
    foundOn: one('found_on').trim() || fresh.foundOn,
    role: roleOf(one('role')),
    people: fresh.people.map((_, i) => ({ who: one(`f${i}_who`).trim(), role: roleOf(one(`f${i}_role`)) })),
    shownPeople: clamp(Number(one('people')), 0, PEOPLE),
    label: one('label').trim(),
    state: US_STATES.has(one('state')) ? one('state') : '',
    lat: one('lat').trim(),
    lng: one('lng').trim(),
    approximate: one('approximate') === '1'
  };
}

/** A number's mark on the first photo, from its field (`x,y,w,h`, fractions), or undefined. */
function boxOf(raw: string): [number, number, number, number] | undefined {
  const v = raw.split(',').map(Number);
  return v.length === 4 && v.every((n) => Number.isFinite(n)) ? (v as [number, number, number, number]) : undefined;
}

/** The numbers typed, each with the row it came from (for what an error names). */
const typedNumbers = (d: Draft) =>
  d.numbers
    .slice(0, d.rows)
    .map((n, row) => ({ ...n, row }))
    .filter((n) => n.value);

/** The draft as `POST /signs` takes it. */
export function postBody(d: Draft, player: Player): Record<string, unknown> {
  const body: Record<string, unknown> = {
    photo_ids: d.photos,
    title: d.title,
    numbers: typedNumbers(d).map((n) => {
      const box = boxOf(n.box);
      return { value: n.value, ...(n.text && { text: n.text }), ...(box && { box }) };
    }),
    place: {
      label: d.label,
      ...(d.state && { state: d.state }),
      ...((d.lat || d.lng) && { lat: Number(d.lat), lng: Number(d.lng) }),
      approximate: d.approximate
    },
    found_on: d.foundOn
  };
  if (d.caption) body.caption = d.caption;
  const others = d.people
    .filter((p) => p.who)
    .map((p) =>
      p.who.startsWith('@') ? { handle: p.who.slice(1).toLowerCase(), role: p.role } : { name: p.who, role: p.role }
    );
  // Found by the poster alone is what the server does with no finders; anything else names everyone.
  if (others.length || d.role !== 'found') body.finders = [{ handle: player.handle, role: d.role }, ...others];
  return body;
}

/** A server message about a field, in the form's own words. */
export function inWords(message: string, d: Draft): string {
  const rows = typedNumbers(d).map((n) => n.row);
  const named = message
    .replace(/^numbers\[(\d+)\]\.value/, (_, i) => `Number ${(rows[Number(i)] ?? Number(i)) + 1}`)
    .replace(/^numbers\[(\d+)\]\.text/, (_, i) => `What number ${(rows[Number(i)] ?? Number(i)) + 1} is read from`)
    .replace(/^numbers\[(\d+)\]\.box/, (_, i) => `The mark for number ${(rows[Number(i)] ?? Number(i)) + 1}`)
    .replace(/^finders\[(\d+)\]\.name/, 'A name under who found it')
    .replace(/^place\.label/, 'The place')
    .replace(/^place\.lat/, 'The latitude')
    .replace(/^place\.lng/, 'The longitude')
    .replace(/^found_on is a date like/, 'The day found is a date like')
    .replace(/^title/, 'The title')
    .replace(/^caption/, 'The caption');
  return sentence(named);
}

/** What stops the details going on to the math, in the form's words, before the server's own check. */
export function detailsTrouble(d: Draft, now: number): string | undefined {
  if (!d.photos.length) return 'Add a photo of the sign.';
  if (!typedNumbers(d).length) return 'Type the numbers on the sign.';
  if (!d.title) return 'Give the sign a title.';
  if (!d.label) return 'Say where the sign is: a town, a road or a place.';
  if (!d.lat !== !d.lng) return 'Type both the latitude and the longitude, or neither.';
  try {
    // A stand-in poster: who the player is changes nothing readPost checks.
    readPost(postBody(d, { handle: 'you' } as Player), now);
  } catch (err) {
    if (err instanceof ApiError) return inWords(err.message, d);
    throw err;
  }
  return undefined;
}

/**
 * The details form's field an error is about, by its id, so the page can focus it and tie it to the
 * error; undefined when no one field is (the error itself takes the focus then).
 */
export function fieldOf(message: string, d: Pick<Draft, 'lat'>): string | undefined {
  const row = /^(Number|What number) (\d+)/.exec(message);
  if (row) return `n${Number(row[2]) - 1}${row[1] === 'Number' ? '' : 't'}`;
  const starts: [string, string][] = [
    ['Add a photo', 'photo-file'],
    ['Choose a photo', 'photo-file'],
    ['Type the numbers', 'n0'],
    ['Give the sign a title', 'title'],
    ['The title', 'title'],
    ['The caption', 'caption'],
    ['The day found', 'found_on'],
    ['Say where the sign is', 'label'],
    ['The place', 'label'],
    ['The latitude', 'lat'],
    ['The longitude', 'lng'],
    ['Type both the latitude and the longitude', d.lat ? 'lng' : 'lat']
  ];
  return starts.find(([start]) => message.startsWith(start))?.[1];
}

// ---------------------------------------------------------------------------------------------
// Routes

type PostFront = {
  options: ApiOptions;
  jar: Jar;
  /** Draws a page as the signed-in side's answer (never cached). */
  page: (c: Context, body: Child, status?: Status) => Promise<Response>;
  /** Quiz's address while it is open. */
  quiz?: string;
};

/** Mounts `/post` on the signed-in side. */
export function mountPost(app: Hono, { options, jar, page, quiz }: PostFront): void {
  const { store, photos } = options;
  const quizOpen = quiz !== undefined;
  const go = (c: Context, path: string) => c.redirect(path, 303);
  const toSignIn = `${SITE_PATHS.signin}?to=${encodeURIComponent(POST_PATH)}`;
  const toName = `${SITE_PATHS.name}?to=${encodeURIComponent(POST_PATH)}`;

  async function poster(c: Context): Promise<Player | Response> {
    const viewer = await sessionViewer(store, c, jar);
    if (!viewer) return go(c, toSignIn);
    if (!viewer.player.name) return go(c, toName);
    return viewer.player;
  }

  /** The signs a post may be the same as: what this player sees, near the place, sharing numbers. */
  async function similarTo(player: Player, d: Draft) {
    if (!d.lat || !d.lng) return [];
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    const wanted = typedNumbers(d).map((n) => n.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !wanted.length) return [];
    const [signs, blocks] = await Promise.all([store.allSigns(), store.listBlocks(player.id)]);
    const blocked = new Set(blocks.map((b) => b.blockedId));
    // In the same normal form as the API's lookup (`GET /signs/similar`).
    const values = wanted.filter((n) => NUMBER.test(n)).map(normalizeNumber);
    return similarSigns(signs.filter(visibleTo(player.id, blocked)), lat, lng, values).slice(0, 5);
  }

  const details = (
    c: Context,
    who: Player,
    d: Draft,
    extra: { error?: string; field?: string; said?: string; fresh?: boolean },
    status?: Status
  ) =>
    page(
      c,
      <DetailsPage
        draft={d}
        quiz={quiz}
        owner={draftOwner(who.id)}
        {...extra}
        field={extra.error ? (extra.field ?? fieldOf(extra.error, d)) : undefined}
      />,
      status
    );

  const math = async (
    c: Context,
    player: Player,
    d: Draft,
    extra: { error?: string; tried?: string },
    status?: Status
  ) =>
    page(
      c,
      <MathPage
        draft={d}
        quiz={quiz}
        similar={await similarTo(player, d)}
        site={options.urls.site}
        quizOpen={quizOpen}
        {...extra}
      />,
      status
    );

  app.get(POST_PATH, async (c) => {
    const who = await poster(c);
    if (who instanceof Response) return who;
    return details(c, who, freshDraft(), { fresh: true });
  });

  app.post(POST_PATH, async (c) => {
    const who = await poster(c);
    if (who instanceof Response) return who;
    const wantsJson = (c.req.header('accept') ?? '').includes('application/json');
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MOST_BYTES) {
      const message = `A photo can be at most ${LIMITS.photoBytes / 1024 / 1024} MB.`;
      if (wantsJson) return c.json({ error: { message } }, 413);
      return page(c, <Message title="That was too big" message={message} quiz={quiz} />, 413);
    }
    const body = (await c.req.parseBody({ all: true })) as Body;
    const d = readDraft(body);
    const step = typeof body.go === 'string' ? body.go : 'math';
    const file = [body.photo].flat().find((f): f is File => typeof f === 'object' && f !== null && f.size > 0);

    // A photo, sent alone by the script or with the form, goes up first.
    if (file) {
      try {
        if (d.photos.length >= LIMITS.photosMax) fail413(`A sign has at most ${LIMITS.photosMax} photos.`);
        const up = await uploadPhoto(options, who, file.type, () => file.arrayBuffer(), file.size);
        d.photos.push(up.id);
        if (wantsJson) return c.json({ id: up.id, thumb_url: `${POST_PATH}/photos/${up.id}/thumb.jpg` });
      } catch (err) {
        const status = trouble(err, ['bad_request', 'too_large', 'rate_limited']);
        const message = sentence((err as ApiError).message);
        if (wantsJson) return c.json({ error: { message } }, status);
        const room = d.photos.length < LIMITS.photosMax;
        return details(c, who, d, { error: message, field: room ? 'photo-file' : undefined }, status);
      }
      if (step === 'photo') return details(c, who, d, { said: 'Photo added.' });
    } else if (step === 'photo') {
      if (wantsJson) return c.json({ error: { message: 'Choose a photo first.' } }, 400);
      return details(c, who, d, { error: 'Choose a photo first.' }, 400);
    }

    if (step.startsWith('drop:')) {
      d.photos = d.photos.filter((p) => p !== step.slice(5));
      return details(c, who, d, { said: 'Photo removed.' });
    }
    if (step === 'more') {
      d.rows = Math.min(LIMITS.numbersMax, d.rows + 1);
      return details(c, who, d, {});
    }
    if (step === 'person') {
      d.shownPeople = Math.min(PEOPLE, d.shownPeople + 1);
      return details(c, who, d, {});
    }
    if (step === 'back') return details(c, who, d, {});

    const wrong = detailsTrouble(d, Math.floor(Date.now() / 1000));
    if (wrong) return details(c, who, d, { error: wrong }, 400);
    if (step !== 'post' && step !== 'unsolved') return math(c, who, d, {});

    const tried = step === 'post' && typeof body.text === 'string' ? body.text : undefined;
    try {
      const { sign } = await postSign(
        options,
        who,
        { ...postBody(d, who), ...(tried !== undefined && { way: tried }) },
        d.key,
        'site'
      );
      return go(c, `${POST_PATH}/done/${sign.id}`);
    } catch (err) {
      const status = trouble(err, ['bad_request', 'too_large', 'rate_limited', 'conflict', 'unavailable']);
      return math(c, who, d, { error: inWords((err as ApiError).message, d), tried }, status);
    }
  });

  /** A photo of the poster's own that is waiting to be posted. */
  app.get(`${POST_PATH}/photos/:id/thumb.jpg`, async (c) => {
    const viewer = await sessionViewer(store, c, jar);
    const id = c.req.param('id');
    if (!viewer || !PHOTO_ID.test(id) || !(await store.getUpload(viewer.player.id, id))) return c.notFound();
    const bytes = await photos.get(id, 'thumb', 'upload');
    if (!bytes) return c.notFound();
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' });
  });

  app.get(`${POST_PATH}/done/:id`, async (c) => {
    const who = await poster(c);
    if (who instanceof Response) return who;
    const sign = await store.getSign(c.req.param('id').toUpperCase());
    if (!sign || sign.postedBy !== who.id) return go(c, SITE_PATHS.profile);
    return page(c, <DonePage sign={sign} site={options.urls.site} quiz={quiz} script={doneJs(who.id)} />);
  });
}

function fail413(message: string): never {
  throw new ApiError('too_large', message);
}

// ---------------------------------------------------------------------------------------------
// Pages

/** The keypad's style, from Quiz's, kept inside `.acct` like the rest of the signed-in side's. */
const KEYPAD_STYLE = `
.acct .btn[disabled] { background: var(--line); color: var(--soft); cursor: default; }
.acct .plate { background: var(--green); border-radius: 16px; padding: 5px; }
.acct .plate > div { border: 2.5px solid #fff; border-radius: 12px; color: #fff; font: 500 24px/1.2 'STIX Two Text', Georgia, serif;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px 8px; padding: 14px 10px; min-height: 96px;
  text-align: center; overflow-x: auto; }
.acct .plate > div.empty { font: 800 17px Overpass, system-ui, sans-serif; color: #E3EFE9; }
.acct .tiles { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.acct .tiles.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.acct .nt { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 54px;
  padding: 4px; border-radius: 10px; border: 1.5px solid var(--green-ink); background: var(--card); color: var(--green-ink);
  font: inherit; cursor: pointer; width: 100%; touch-action: manipulation; }
.acct .nt b { font: 700 20px/1.1 'Overpass Mono', ui-monospace, monospace; }
.acct .nt small { font-size: 11px; font-weight: 700; color: var(--soft); max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.acct .nt.used { border-color: var(--line); background: var(--ground); color: var(--soft); cursor: default; }
.acct .keys { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 7px; }
.acct .k { height: 46px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink);
  font: inherit; font-size: 20px; font-weight: 800; cursor: pointer; touch-action: manipulation; }
.acct .k.del { grid-column: span 2; }
.acct .chk { display: flex; gap: 10px; align-items: center; min-height: 46px; padding: 8px 14px; border-radius: 12px; font-size: 15px; }
.acct .chk .said { flex: 1; }
.acct .chk .aside { font-size: 13px; font-weight: 700; }
.acct .chk.ok { background: var(--tint); color: var(--tint-ink); font-weight: 800; }
.acct .chk.wait { background: var(--ground); color: var(--ink2); font-weight: 700; }
`;

const POST_STYLE = `
.acct .post { max-width: 640px; }
.acct [hidden] { display: none !important; }
.acct fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.acct legend { padding: 0; margin-bottom: 4px; font-size: 19px; font-weight: 900; }
.acct .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.acct textarea.field { min-height: 96px; resize: vertical; }
.acct select.field { appearance: auto; }
.acct .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.acct .two > div, .acct .num > div { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.acct .num { display: grid; grid-template-columns: 7rem 1fr; gap: 10px; align-items: end; padding-top: 10px;
  border-top: 1px solid var(--rule); }
.acct .num .mark-btn { grid-column: 1 / -1; justify-self: start; min-height: 36px; padding: 0; }
.acct .num[hidden], .acct .who[hidden] { display: none; }
.acct .who { display: grid; grid-template-columns: 1fr 10rem; gap: 10px; align-items: end; }
.acct .who > div { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.acct .shots { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.acct .shots li { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.acct .shots img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: var(--photo); }
.acct .shots .txt { min-height: 36px; font-size: 14px; }
.acct .mark { position: relative; align-self: flex-start; max-width: 100%; }
.acct .mark img { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; cursor: crosshair; }
.acct .mark .box { position: absolute; border: 3px solid #F2B300; border-radius: 6px; color: #18201C; background: #F2B30055;
  font-size: 12px; font-weight: 900; display: flex; align-items: flex-start; justify-content: flex-start; padding: 0 3px;
  pointer-events: none; }
.acct .mark .box.on { border-color: var(--green); }
.acct .pick-map { height: 320px; border-radius: 12px; border: 1px solid var(--line); }
.acct .check { display: flex; gap: 10px; align-items: center; font-weight: 700; }
.acct .check input { width: 22px; height: 22px; }
.acct .alike { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.acct .alike li { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--rule); align-items: flex-start; }
.acct .alike img, .acct .alike .noimg { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; background: var(--photo);
  flex: 0 0 auto; }
.acct .alike .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acct .alike .links { display: flex; gap: 12px; flex-wrap: wrap; }
.acct .alike .txt { min-height: 36px; padding: 0; }
.acct .done-photo { max-width: 100%; max-height: 360px; border-radius: 14px; align-self: flex-start; }
@media (max-width: 559px) { .acct .two { grid-template-columns: 1fr; } .acct .num { grid-template-columns: 5.5rem 1fr; }
  .acct .who { grid-template-columns: 1fr; } .acct .shots { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const PostFrame: FC<PropsWithChildren<{ title: string; quiz?: string; script?: string }>> = ({
  title,
  quiz,
  script,
  children
}) => (
  <Page
    title={`${title} · Road Sign Math`}
    description="Post a road sign to Road Sign Math."
    quiz={quiz}
    banner={false}
    count={false}
    style={FORM_STYLE + KEYPAD_STYLE + POST_STYLE}
    script={script}
  >
    <main id="main" class="wrap acct">
      <div class="stack post">{children}</div>
    </main>
  </Page>
);

const Message: FC<{ title: string; message: string; quiz?: string }> = ({ title, message, quiz }) => (
  <PostFrame title={title} quiz={quiz}>
    <h1>{title}</h1>
    <p class="lede">{message}</p>
    <a class="btn ghost" href={POST_PATH}>
      Back to posting
    </a>
  </PostFrame>
);

const Said: FC<{ error?: string; said?: string; onField?: boolean }> = ({ error, said, onField }) =>
  error ? (
    <FormError error={error} onField={onField} />
  ) : said ? (
    <p class="note" role="status">
      {said}
    </p>
  ) : null;

const RoleSelect: FC<{ id: string; name: string; value: FinderRole }> = ({ id, name, value }) => (
  <select id={id} name={name} class="field">
    {ROLES.map(([role, words]) => (
      <option value={role} selected={role === value}>
        {words}
      </option>
    ))}
  </select>
);

/** The draft's fields carried as they are from one step to the next. */
const Kept: FC<{ d: Draft }> = ({ d }) => (
  <>
    <input type="hidden" name="key" value={d.key} />
    {d.photos.map((p) => (
      <input type="hidden" name="photos" value={p} />
    ))}
    <input type="hidden" name="rows" value={String(d.rows)} />
    {d.numbers.map((n, i) =>
      n.value || n.text || n.box ? (
        <>
          {n.value && <input type="hidden" name={`n${i}_value`} value={n.value} />}
          {n.text && <input type="hidden" name={`n${i}_text`} value={n.text} />}
          {n.box && <input type="hidden" name={`n${i}_box`} value={n.box} />}
        </>
      ) : null
    )}
    <input type="hidden" name="title" value={d.title} />
    {d.caption && <input type="hidden" name="caption" value={d.caption} />}
    <input type="hidden" name="found_on" value={d.foundOn} />
    <input type="hidden" name="role" value={d.role} />
    {d.people.map((p, i) =>
      p.who ? (
        <>
          <input type="hidden" name={`f${i}_who`} value={p.who} />
          <input type="hidden" name={`f${i}_role`} value={p.role} />
        </>
      ) : null
    )}
    <input type="hidden" name="people" value={String(d.shownPeople)} />
    <input type="hidden" name="label" value={d.label} />
    {d.state && <input type="hidden" name="state" value={d.state} />}
    {d.lat && <input type="hidden" name="lat" value={d.lat} />}
    {d.lng && <input type="hidden" name="lng" value={d.lng} />}
    {d.approximate && <input type="hidden" name="approximate" value="1" />}
  </>
);

/** Step one: the photos and everything about the sign but the math. */
export const DetailsPage: FC<{
  draft: Draft;
  quiz?: string;
  /** The player's part of the draft's key in the browser (`draftOwner`). */
  owner?: string;
  error?: string;
  /** The field the error is about (`fieldOf`), which takes the focus. */
  field?: string;
  said?: string;
  fresh?: boolean;
}> = ({ draft: d, quiz, owner, error, field, said, fresh }) => {
  const bad = (id: string) => invalidField(!!error && field === id);
  const room = d.photos.length < LIMITS.photosMax;
  const shownPeople = Math.max(
    d.shownPeople,
    d.people.reduce((n, p, i) => (p.who ? i + 1 : n), 0)
  );
  return (
    <PostFrame title="Post a sign" quiz={quiz} script={EXIF_JS + '\n' + POST_JS}>
      <h1>Post a sign</h1>
      <p class="lede">Found a sign whose numbers make true math? Add its photo, its numbers and where it was.</p>
      <p class="meta">
        Have an iPhone? Posting is easiest in the <a href="/app">Road Sign Math app</a>.
      </p>
      <Said error={error} said={said} onField={!!field} />
      <form
        id="post-form"
        class="stack"
        method="post"
        action={POST_PATH}
        enctype="multipart/form-data"
        data-fresh={fresh ? '1' : undefined}
        data-draft={owner}
        data-most={String(LIMITS.photosMax)}
      >
        {/* Enter in any field goes on to the math, never removes a photo or adds a row. */}
        <button type="submit" name="go" value="math" class="sr" tabindex={-1} aria-hidden="true">
          Next
        </button>
        <input type="hidden" name="key" value={d.key} />
        <input type="hidden" name="rows" value={String(d.rows)} />
        <input type="hidden" name="people" value={String(shownPeople)} />

        <fieldset class="part">
          <legend>Photos</legend>
          <ul id="shots" class="shots" aria-label="Photos added">
            {d.photos.map((p, i) => (
              <li>
                <img src={`${POST_PATH}/photos/${p}/thumb.jpg`} alt={`Photo ${i + 1}`} />
                <input type="hidden" name="photos" value={p} />
                <button type="submit" name="go" value={`drop:${p}`} class="txt bad">
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div id="photo-pick" class="stack" hidden={!room}>
            <label for="photo-file">{d.photos.length ? 'Add another photo' : 'Add a photo of the sign'}</label>
            <input
              id="photo-file"
              class="field file"
              type="file"
              name="photo"
              accept="image/jpeg,image/png,image/webp"
              {...bad('photo-file')}
            />
            <button id="photo-add" type="submit" name="go" value="photo" class="btn ghost">
              Add this photo
            </button>
            <p class="meta">
              Up to {LIMITS.photosMax} photos, the first one of the sign itself.{' '}
              {/* Only true when the script runs, which shows it. */}
              <span id="photo-reads" hidden>
                Your browser reads where and when a photo was taken, then shrinks it and sends it without those details.
              </span>
            </p>
          </div>
          <p id="photo-said" class="meta" role="status" aria-live="polite"></p>
        </fieldset>

        <fieldset class="part">
          <legend>The numbers</legend>
          <p class="meta">
            Every number on the sign, and where each one came from (Exit 2, Speed limit 55). The math has to use them
            all.
          </p>
          <div id="mark" class="mark" hidden>
            <img alt="The first photo. Tap where the number is." />
          </div>
          <p id="mark-said" class="meta" role="status" aria-live="polite"></p>
          {d.numbers.map((n, i) => (
            <div class="num" hidden={i >= d.rows}>
              <div>
                <label for={`n${i}`}>Number {i + 1}</label>
                <input
                  id={`n${i}`}
                  class="field"
                  name={`n${i}_value`}
                  inputmode="decimal"
                  autocomplete="off"
                  value={n.value}
                  {...bad(`n${i}`)}
                />
              </div>
              <div>
                <label for={`n${i}t`}>Read from</label>
                <input
                  id={`n${i}t`}
                  class="field"
                  name={`n${i}_text`}
                  maxlength={40}
                  autocomplete="off"
                  placeholder={i === 0 ? 'Exit 2' : undefined}
                  value={n.text}
                  {...bad(`n${i}t`)}
                />
              </div>
              <input type="hidden" name={`n${i}_box`} value={n.box} />
              <button type="button" class="txt mark-btn" data-row={String(i)} hidden>
                {n.box ? `Mark number ${i + 1} again` : `Mark number ${i + 1} on the photo`}
              </button>
            </div>
          ))}
          {d.rows < LIMITS.numbersMax && (
            <button type="submit" name="go" value="more" class="txt" data-more="num" data-count="rows">
              Add another number
            </button>
          )}
        </fieldset>

        <fieldset class="part">
          <legend>About it</legend>
          <label for="title">Title</label>
          <input id="title" class="field" name="title" maxlength={LIMITS.titleMax} value={d.title} {...bad('title')} />
          <label for="caption">Caption (if you like)</label>
          <textarea id="caption" class="field" name="caption" maxlength={LIMITS.captionMax} {...bad('caption')}>
            {d.caption}
          </textarea>
          <label for="found_on">Day found</label>
          <input
            id="found_on"
            class="field"
            type="date"
            name="found_on"
            max={today()}
            min="2000-01-01"
            value={d.foundOn}
            data-auto={fresh ? '1' : '0'}
            {...bad('found_on')}
          />
        </fieldset>

        <fieldset class="part">
          <legend>Who found it</legend>
          <label for="role">You</label>
          <RoleSelect id="role" name="role" value={d.role} />
          {d.people.map((p, i) => (
            <div class="who" hidden={i >= shownPeople}>
              <div>
                <label for={`f${i}`}>Someone else</label>
                <input
                  id={`f${i}`}
                  class="field"
                  name={`f${i}_who`}
                  maxlength={40}
                  autocomplete="off"
                  placeholder="A name, or @handle for a player"
                  value={p.who}
                />
              </div>
              <div>
                <label for={`f${i}r`} class="sr">
                  What they did
                </label>
                <RoleSelect id={`f${i}r`} name={`f${i}_role`} value={p.role} />
              </div>
            </div>
          ))}
          {shownPeople < PEOPLE && (
            <button type="submit" name="go" value="person" class="txt" data-more="who" data-count="people">
              Add someone who was there
            </button>
          )}
        </fieldset>

        <fieldset class="part">
          <legend>Where it was</legend>
          <div class="two">
            <div>
              <label for="label">Place</label>
              <input
                id="label"
                class="field"
                name="label"
                maxlength={LIMITS.placeMax}
                placeholder="Lanesboro, or I-35W at Exit 2"
                value={d.label}
                {...bad('label')}
              />
            </div>
            <div>
              <label for="state">State</label>
              <select id="state" name="state" class="field">
                <option value="">None</option>
                {[...US_STATES].map((s) => (
                  <option value={s} selected={s === d.state}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p class="meta">
            {/* Without scripts nothing reads the photo and there's no map to pick on; the script swaps these. */}
            <span id="place-plain">Know its latitude and longitude? Type them and it gets a pin on the map.</span>
            <span id="place-script" hidden>
              It goes on the map where the photo says it was taken. No place in the photo? Pick it on the map, or type
              its latitude and longitude.
            </span>{' '}
            Road Sign Math never asks your browser where you are.
          </p>
          <button id="map-open" type="button" class="btn ghost" hidden>
            Pick it on the map
          </button>
          <div id="pick-map" class="pick-map" hidden></div>
          <button id="map-centre" type="button" class="txt" hidden>
            Put it at the map’s centre
          </button>
          <p id="map-said" class="meta" role="status" aria-live="polite"></p>
          <div class="two">
            <div>
              <label for="lat">Latitude</label>
              <input
                id="lat"
                class="field"
                name="lat"
                inputmode="decimal"
                autocomplete="off"
                value={d.lat}
                {...bad('lat')}
              />
            </div>
            <div>
              <label for="lng">Longitude</label>
              <input
                id="lng"
                class="field"
                name="lng"
                inputmode="decimal"
                autocomplete="off"
                value={d.lng}
                {...bad('lng')}
              />
            </div>
          </div>
          <label class="check">
            <input type="checkbox" name="approximate" value="1" checked={d.approximate} />
            The spot is only roughly right
          </label>
        </fieldset>

        <button type="submit" name="go" value="math" class="btn">
          Next: the math
        </button>
      </form>
    </PostFrame>
  );
};

type Alike = { sign: Sign; miles: number };

/** Step two: posted already?, then the first way on the keypad, or post it unsolved. */
export const MathPage: FC<{
  draft: Draft;
  quiz?: string;
  quizOpen: boolean;
  site: string;
  similar: Alike[];
  error?: string;
  tried?: string;
}> = ({ draft: d, quiz, quizOpen, site, similar, error, tried }) => {
  const numbers = typedNumbers(d).map((n) => ({ value: n.value, ...(n.text && { text: n.text }) }));
  return (
    <PostFrame title="The math" quiz={quiz} script={CHECKER_JS + '\n' + KEYPAD_JS}>
      <h1>{d.title}</h1>
      <ul class="shots" aria-label="Photos">
        {d.photos.map((p, i) => (
          <li>
            <img src={`${POST_PATH}/photos/${p}/thumb.jpg`} alt={`Photo ${i + 1}`} />
          </li>
        ))}
      </ul>
      {similar.length > 0 && (
        <section class="part" aria-labelledby="alike-h">
          <h2 id="alike-h" class="h2">
            Posted already?
          </h2>
          <p class="meta">
            {similar.length === 1 ? 'This sign is' : 'These signs are'} close by, with some of the same numbers. If it’s
            the same sign, put your math on it as another way. If it’s a different sign, go ahead and post yours.
          </p>
          <ul class="alike">
            {similar.map(({ sign, miles }) => {
              const photo = sign.photos[0];
              return (
                <li>
                  {photo && isPublic(sign) ? (
                    <img src={photoUrl({ site }, photo.id, 'thumb')} alt={photo.alt ?? ''} loading="lazy" />
                  ) : (
                    <span class="noimg" />
                  )}
                  <div class="what">
                    <strong>{sign.title}</strong>
                    <span class="meta">
                      {[
                        sign.place.label,
                        miles < 0.1 ? 'right there' : `${Math.round(miles * 10) / 10} mi away`,
                        sign.numbers.map((n) => n.value).join(', ')
                      ].join(' · ')}
                    </span>
                    {isPublic(sign) && (
                      <span class="links">
                        <a class="txt" href={signPath(sign)}>
                          See it
                        </a>
                        {quizOpen && quiz && (
                          <a class="txt" href={`${quiz}${signPath(sign)}`}>
                            Find another way
                          </a>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section class="part" aria-labelledby="way-h">
        <h2 id="way-h" class="h2">
          The first way
        </h2>
        <p class="meta">Make the math with the sign’s numbers. Use every one.</p>
        <FormError error={error} />
        <form id="solve" class="stack" method="post" action={POST_PATH}>
          <Kept d={d} />
          <input type="hidden" name="go" value="post" />
          <Keypad numbers={numbers} value={tried ?? ''} again={!!error && !!tried} />
          <button id="send" class="btn" type="submit">
            Post the sign
          </button>
        </form>
        <form method="post" action={POST_PATH} class="stack">
          <Kept d={d} />
          <button class="btn ghost" type="submit" name="go" value="unsolved">
            Post it unsolved
          </button>
          <p class="meta">Can’t find the math? Post it anyway, and someone else may.</p>
          <button class="txt" type="submit" name="go" value="back">
            Back to the details
          </button>
        </form>
        <p class="meta">
          By posting you agree to the <a href="/rules">house rules</a>. Our moderator looks at every post.
        </p>
      </section>
    </PostFrame>
  );
};

/** What became of a post: shown, or held with the moderator's note. */
export const DonePage: FC<{ sign: Sign; site: string; quiz?: string; script?: string }> = ({
  sign,
  site,
  quiz,
  script
}) => {
  const photo = sign.photos[0];
  const held = !isPublic(sign);
  const src = photo ? (held ? `/you/photos/${photo.id}/thumb.jpg` : photoUrl({ site }, photo.id, 'large')) : undefined;
  return (
    <PostFrame title={held ? 'Held for now' : 'Posted'} quiz={quiz} script={script}>
      {held ? (
        <>
          <span class="pill y" style="align-self: flex-start">
            Held
          </span>
          <h1>{sign.title} is held for now</h1>
          {sign.moderation?.note && <p class="note">{sign.moderation.note}</p>}
          <p class="lede">Only you can see it. It stays on your page with the reason.</p>
        </>
      ) : (
        <>
          <h1>{sign.title} is posted</h1>
          <p class="lede">
            {sign.firstWay ? 'With its first way.' : 'Unsolved for now, so anyone can find the first way.'} It can take
            a minute to show up everywhere.
          </p>
        </>
      )}
      {src && <img class="done-photo" src={src} alt={photo!.alt ?? ''} />}
      {!held && (
        <a class="btn" href={signPath(sign)}>
          See it
        </a>
      )}
      <a class="btn ghost" href={SITE_PATHS.profile}>
        Your signs
      </a>
      <a class="txt" href={POST_PATH}>
        Post another sign
      </a>
    </PostFrame>
  );
};
