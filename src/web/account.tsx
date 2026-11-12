// The website's signed-in side (wave 2, packages 2A and 2B): sign in on roadsignmath.xyz by email,
// the name step, posting a sign (`/post`, src/web/post.tsx), and `/you`, the player's own page: the profile (photo, name, bio, website, home, through
// the same moderated `updateMe` as the app and Quiz), the signs they posted, held and hidden ones
// included with why, Delete a sign, Sign out and Delete my account. The sign-in and profile pages
// are Quiz's (src/quiz/account.tsx and pages.tsx), drawn in the site's frame.
//
// Everything here is off until `SITE_SIGNIN_OPEN` is true; off, none of it is mounted, the header
// is as it was, and Quiz keeps its own cookie, so the site answers exactly as before. Open:
//
// - It answers only under `/signin`, `/you` and `/post` (the paths the site's distribution never
//   caches and forwards the sign-in cookie to, infra/template.yaml), always `no-store`. Every
//   other page stays cached, without a cookie, and the same for everyone.
// - `GET /signin` with a link's `l` and `t` is still the iPhone app's landing page (site.tsx),
//   which the App Store app opens (src/web/apple.ts). This sign-in's email links `/signin/link`.
// - One cookie for the site and Quiz (`rsm_session`, src/quiz/session.ts). Cached pages show
//   "Sign in" in the header, and a small script swaps in the player's face from `rsm_me`, a marker
//   that holds no secret (`withSignIn`).
// - No GET changes anything, and every POST must carry the site's own Origin.

import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { ApiOptions } from '../api/app.ts';
import { ApiError } from '../api/errors.ts';
import { isPublic, photoUrl, signPath } from '../api/views.ts';
import type { Player, Sign } from '../domain/types.ts';
import { deleteSign } from '../posting/posting.ts';
import { mountAccount, sentence, trouble, type Status } from '../quiz/account.tsx';
import { onSigns, credits } from '../quiz/data.ts';
import { Face, Frame, MessagePage, SITE_PATHS, type Here } from '../quiz/pages.tsx';
import { QUIZ_OPEN, quizOrigin } from '../quiz/quiz.tsx';
import { MARKER_COOKIE, forget, fromOrigin, jarFor, sessionViewer } from '../quiz/session.ts';
import { POST_PATH, mountPost } from './post.tsx';

/**
 * Whether the website's sign-in is open. Jamie opened it on 2026-11-12 ("turn it on for everyone");
 * false, the site answers as it did before. `siteSignInOpen` in the options overrides it (tests, and
 * `npm run dev`, which keeps it shut unless `SITE_SIGNIN_OPEN=1`).
 */
export const SITE_SIGNIN_OPEN = true;

/**
 * The path groups the signed-in side answers under. Each has a behaviour of its own on the site's
 * distribution that is never cached and forwards the sign-in cookie (`test/cache-key.test.ts`
 * checks the two lists agree). `/post` is posting from the website (src/web/post.tsx).
 */
export const ACCOUNT_PATHS = ['/signin', '/signin/*', '/you', '/you/*', '/post', '/post/*'] as const;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

/** The header's "Sign in", which the marker script turns into the player's face. */
const SIGN_IN_LINK = '<a class="you" href="/signin">Sign in</a>';

const WHO_STYLE = `<style>.top .you { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; margin-left: auto;
  font-weight: 800; text-decoration: none; color: var(--ink); }
.top .you + .get { margin-left: 0; }
.top .you .avatar { width: 36px; height: 36px; font-size: 16px; padding-top: 2px; }
.top .you .avatar.photo { padding: 0; }
.top .you .av { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff;
  font-weight: 900; padding-top: 2px; overflow: hidden; }
.top .you .av.ink { color: #18201C; }
.top .you .av.pic { padding: 0; background: var(--photo); }
.top .you .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 759px) { .top .you .label { display: none; } .top .lockup img { height: 28px; } }</style>`;

/**
 * Reads `rsm_me` (no secret: a colour, a photo id, a first letter) and puts the player's face where
 * "Sign in" is, linking `/you`. Each part is checked before it is used, and the letter goes in as
 * text, so a marker someone else set can't put anything else on the page.
 */
export const WHO_SCRIPT = `(() => {
  const a = document.querySelector('.top .you');
  const m = document.cookie.split('; ').find((c) => c.startsWith('${MARKER_COOKIE}='));
  if (!a || !m) return;
  const p = decodeURIComponent(m.slice(${MARKER_COOKIE.length + 1})).split('.');
  if (p.length !== 4 || p[0] !== '1' || !/^[0-9a-fA-F]{6}$/.test(p[1]) || !/^[\\w-]*$/.test(p[2]) || [...p[3]].length !== 1) return;
  const face = document.createElement('span');
  face.setAttribute('aria-hidden', 'true');
  if (p[2]) {
    face.className = 'avatar photo';
    const img = document.createElement('img');
    img.src = '/p/' + p[2] + '/thumb.jpg';
    img.alt = '';
    face.append(img);
  } else {
    face.className = p[1].toUpperCase() === 'F2B300' ? 'avatar ink' : 'avatar';
    face.style.background = '#' + p[1];
    face.textContent = p[3];
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'You';
  a.replaceChildren(label, face);
  a.href = '/you';
  a.setAttribute('aria-label', 'You: your profile and signs');
})();`;

/**
 * A site page with the header's sign-in: "Sign in" before Get the app, the marker script that
 * swaps in the face, and, on the signed-in side's own pages (`player`), the face drawn here.
 * Cached pages all get the same words, so nothing is cached per person.
 */
export function withSignIn(html: string, player?: Player, site = ''): string {
  const at = html.indexOf('<a class="get"');
  const end = html.lastIndexOf('</body>');
  const head = html.indexOf('</head>');
  if (at < 0 || end < 0 || head < 0 || html.includes('<a class="you"')) return html;
  const link = player
    ? `<a class="you" href="/you" aria-label="You: your profile and signs"><span class="label">You</span>${faceHtml(player, site)}</a>`
    : SIGN_IN_LINK;
  const script = player ? '' : `<script>${WHO_SCRIPT}</script>`;
  return html.slice(0, head) + WHO_STYLE + html.slice(head, at) + link + html.slice(at, end) + script + html.slice(end);
}

const faceHtml = (player: Player, site: string) =>
  (<Face player={player} size={36} here={{ site, quiz: site, front: 'site' }} />).toString();

/**
 * The site's middleware for the header's sign-in, on every page the site draws while it is open:
 * an HTML answer gets "Sign in" (the signed-in side's own pages draw the face instead).
 */
export const signInHeader = () => async (c: Context, next: () => Promise<void>) => {
  await next();
  // The iPhone app's sign-in landing stays as it is.
  if (c.req.path === '/signin' || !c.res.headers.get('content-type')?.startsWith('text/html')) return;
  const html = await c.res.text();
  const headers = new Headers(c.res.headers);
  headers.delete('content-length');
  c.res = new Response(withSignIn(html), { status: c.res.status, headers });
};

type AccountOptions = ApiOptions & { clientIp: (c: Context) => string };

/** The signed-in side, mounted on the site before its pages while `SITE_SIGNIN_OPEN`. */
export function createAccount(options: AccountOptions): Hono {
  const { store, urls } = options;
  const here: Here = { site: urls.site, quiz: urls.quiz ?? quizOrigin(urls.site), front: 'site' };
  const jar = jarFor(urls.site, true);
  const app = new Hono();

  const page = async (c: Context, body: Child, status: Status = 200) => {
    const viewer = await sessionViewer(store, c, jar);
    const html = withSignIn('<!doctype html>' + (body as { toString(): string }).toString(), viewer?.player, urls.site);
    return c.html(html, status, NO_STORE);
  };
  const go = (c: Context, path: string) => c.redirect(path, 303);

  for (const path of ACCOUNT_PATHS) {
    app.use(path, async (c, next) => {
      if (c.req.method === 'POST' && !fromOrigin(c, urls.site)) {
        return page(
          c,
          <MessagePage
            here={here}
            title="That didn’t come from Road Sign Math"
            message="Go back to roadsignmath.xyz and try again."
          />,
          400
        );
      }
      await next();
      // Whatever answers here, the app's sign-in landing and a 404 included, is never cached.
      c.header('Cache-Control', 'no-store');
    });
  }

  /** Whether the site has a page for the player yet (a sign or a way), and the signs they posted. */
  async function profileOf(player: Player) {
    const signs = await store.allSigns();
    const shown = signs.filter(isPublic);
    const on = await onSigns(store, shown);
    const hasPage = shown.some(
      (s) =>
        credits(s, player.id) ||
        on.get(s.id)?.ways.some((w) => w.playerId === player.id) ||
        on.get(s.id)?.coFinds.some((f) => f.playerId === player.id)
    );
    return { hasPage, posted: signs.filter((s) => s.postedBy === player.id).length };
  }

  const posted = async (player: Player) =>
    (await store.allSigns())
      .filter((s) => s.postedBy === player.id)
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

  mountAccount(app, {
    options,
    here,
    jar,
    page,
    // The site's sign-in lands on `/you`, or back on the posting form a signed-out player opened.
    backTo: (raw) => (raw === POST_PATH ? POST_PATH : undefined),
    onward: (to) => to ?? SITE_PATHS.profile,
    profileOf,
    yours: async (player) => <YourSigns signs={await posted(player)} site={urls.site} />,
    deletedWords: 'It’s gone, with everything it made, here, in Quiz and in the app. Thanks for playing Road Sign Math.'
  });

  mountPost(app, { options, jar, page, quiz: (options.quizOpen ?? QUIZ_OPEN) ? here.quiz : undefined });

  /** A sign of theirs, by id, in any state, or undefined. */
  const yourSign = async (player: Player, id: string) => (await posted(player)).find((s) => s.id === id.toUpperCase());

  /** A held or hidden sign's photo, for its poster only (the API's `GET /me/photos/{id}/{size}`). */
  app.get('/you/photos/:photo/:size', async (c) => {
    const viewer = await sessionViewer(store, c, jar);
    const size = c.req.param('size');
    if (!viewer || (size !== 'thumb.jpg' && size !== 'large.jpg')) return c.notFound();
    const id = c.req.param('photo');
    const sign = (await posted(viewer.player)).find((s) => s.photos.some((p) => p.id === id));
    if (!sign) return c.notFound();
    const bytes = await options.photos.get(
      id,
      size === 'thumb.jpg' ? 'thumb' : 'large',
      isPublic(sign) ? 'shown' : 'held'
    );
    if (!bytes) return c.notFound();
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg', ...NO_STORE });
  });

  app.get('/you/signs/:id/delete', async (c) => {
    const viewer = await sessionViewer(store, c, jar);
    if (!viewer) return go(c, SITE_PATHS.signin);
    const sign = await yourSign(viewer.player, c.req.param('id'));
    if (!sign) return go(c, SITE_PATHS.profile);
    return page(c, <DeleteSignPage here={here} sign={sign} />);
  });

  app.post('/you/signs/:id/delete', async (c) => {
    const viewer = await sessionViewer(store, c, jar);
    if (!viewer) return go(c, SITE_PATHS.signin);
    const sign = await yourSign(viewer.player, c.req.param('id'));
    if (!sign) return go(c, SITE_PATHS.profile);
    try {
      // The same code as the app's DELETE /signs/{id}: hearts, photos, then the sign.
      await deleteSign(options, viewer.player, sign);
    } catch (err) {
      const status = trouble(err, ['conflict', 'unavailable', 'not_found']);
      return page(c, <DeleteSignPage here={here} sign={sign} error={sentence((err as ApiError).message)} />, status);
    }
    return go(c, `${SITE_PATHS.profile}?done=deleted`);
  });

  app.onError((err, c) => {
    if (err instanceof ApiError && err.code === 'unauthorized') {
      forget(c, jar);
      return go(c, SITE_PATHS.signin);
    }
    console.error(err);
    return c.html(
      '<!doctype html>' +
        (
          <MessagePage
            here={here}
            title="Something broke"
            message="Something went wrong on our side. Try again in a minute."
          />
        ).toString(),
      500,
      NO_STORE
    );
  });

  return app;
}

/** The signs a player posted, in every state: shown ones link their page; held and hidden ones say why. */
const YourSigns = ({ signs, site }: { signs: Sign[]; site: string }) => (
  <section class="part" aria-labelledby="ys-h">
    <h2 id="ys-h" class="h2">
      Signs you posted
    </h2>
    <a class="btn" href={POST_PATH}>
      Post a sign
    </a>
    {signs.length === 0 ? (
      <p class="meta">Signs you post show here, with any only you can see.</p>
    ) : (
      <ul class="mine">
        {signs.map((sign) => {
          const photo = sign.photos[0];
          const src = photo
            ? isPublic(sign)
              ? photoUrl({ site }, photo.id, 'thumb')
              : `/you/photos/${photo.id}/thumb.jpg`
            : undefined;
          return (
            <li>
              {src ? <img src={src} alt={photo!.alt ?? ''} loading="lazy" /> : <span class="noimg" />}
              <div class="what">
                {isPublic(sign) ? <a href={signPath(sign)}>{sign.title}</a> : <strong>{sign.title}</strong>}
                {sign.visibility !== 'shown' && (
                  <>
                    <span class={sign.visibility === 'held' ? 'pill y' : 'pill g'}>
                      {sign.visibility === 'held' ? 'Held' : 'Hidden'}
                    </span>
                    <p class="meta">{[sign.moderation?.note, 'Only you can see it.'].filter(Boolean).join(' ')}</p>
                  </>
                )}
                <a class="txt bad" href={`/you/signs/${sign.id}/delete`}>
                  Delete this sign
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    )}
  </section>
);

/** Asks before a sign goes, as the app does. */
const DeleteSignPage = ({ here, sign, error }: { here: Here; sign: Sign; error?: string }) => (
  <Frame here={here} title="Delete this sign?">
    <div class="stack narrow">
      <h1>Delete {sign.title}?</h1>
      <p class="lede">This deletes the sign, its photos and every way found on it, for everyone. It can’t be undone.</p>
      {error && (
        <p class="oops" role="alert">
          {error}
        </p>
      )}
      <form method="post" action={`/you/signs/${sign.id}/delete`}>
        <button class="btn danger" type="submit">
          Delete this sign
        </button>
      </form>
      <a class="btn ghost" href={SITE_PATHS.profile}>
        Keep it
      </a>
    </div>
  </Frame>
);
