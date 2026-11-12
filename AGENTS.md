# Agent guide: roadsignmath.xyz

The server and website for Road Sign Math, a road trip game: find a road sign whose numbers
make a true equation, photograph it, write the math, post it. `README.md` is the overview for
people; this file is the working rules. `CLAUDE.md` is a symlink to this file.

This repo is **public**. It never holds secrets, signing files, player emails, cloud account
ids or ARNs, local paths, or photos of plates or faces that weren't meant to be shared.

## The game, as built

- **No points.** No scores, scoreboards, ranks, judges or rules of play. The one rules page is
  `/rules`, the house rules for posting (Jamie, 2026-11-10), not a scoring system.
- **The check.** A way is accepted when the math is true and every number in it is one of
  the sign's checked numbers, each used no more often than the sign shows it, and it uses every
  number on the sign (Jamie, 2026-11-12: "require every number in new ways, keep the first-era
  ways"). The rule is in `checkWay` (`src/posting/posting.ts`) for a post's first way, another
  way and a solve, a found-too included; `numbersLeftOut` in the checker names what is left out,
  and Quiz's keypad holds Send until it is empty. The ways already on signs stay, first-era ones
  that leave numbers out included. Every Number is still a badge. `src/domain/equation.ts` is the checker;
  `contracts/equation-vectors.json` holds the cases the server and the iPhone app both pass,
  including each way's LaTeX (`tex`): ÷ is a stacked fraction. The site draws it as SVG with
  MathJax on the server (`src/web/math.ts`); the app draws the same LaTeX with SwiftMath
  and checks its own LaTeX writer against these vectors. **The same way** (`sameWayKey`, Jamie,
  2026-11-11: a reordered way "earns nothing"): two ways are one when they differ only by the order
  of what is added or multiplied (each term keeping its sign, each factor whether it divides, inside
  roots, powers and brackets too), brackets that do nothing, or which side of the `=` is which. A
  new way that is the same as one on the sign is a 409 `conflict` (`REORDERED`, which ends without
  a full stop: the app's Find another way adds one). The vectors' `same_way` pairs hold the rule.
- **Public reads, signed-in writes.** Only `shown` signs are public; a player also sees their
  own held and hidden signs. A player's email never leaves the server, except to the players'
  newsletter on Buttondown (`src/newsletter.ts`).
- **Moderation is Claude's alone** (`src/moderation/`). No person reviews posts. Claude holds a
  post only when it is clearly objectionable, looks again when a player reports one (hiding it
  if it agrees), and writes each photo's alt text in the same call. It also looks at a profile
  photo before it goes up, under the same `POLICY`, and one it wouldn't show is refused. A block hides a player's
  signs and ways from the one who blocked them. What counts as objectionable (`POLICY`) is the
  owner's call: change its words only with the owner's go.
- Product calls (what counts, moderation, what players are promised, who sees what) are the
  owner's. Ship the factual fix and ask about the policy half.

## Layout

| Path | What |
| --- | --- |
| `src/domain/` | The data model (`types.ts`), the equation checker, ids and slugs, miles, and the badges (`badges.ts`: the catalog and the evaluator). No I/O. |
| `src/store/` | `Store`, with `MemoryStore` (tests, `npm run dev`) and `DynamoStore` (the live table). |
| `src/api/` | `/api/v1` on Hono. `contract.ts` is the route table, limits and errors; `openapi.ts` describes it; `views.ts` makes the JSON. |
| `src/web/` | The website, as the design draws it (Hono JSX, public, cached at the edge until it changes (`src/edge-cache.ts`); no sign-in). `site.tsx` has the pages: Home at `/` (the map of every shown sign with the year filter and the picked place's signs, who's playing (the first ten, the most signs first, then a link to `/players`), the twelve newest signs with a link to all of them and sort chips that open `/signs` in that sort (an old `/?sort=` goes there with a 301; Jamie, 2026-11-11), how to play, the app), `/signs` (`signs.tsx`: every shown sign, filtered by the year it was found and its state, Latest grouped by year), a page per sign at `/signs/<slug>` (the slug comes from the title when it is posted and never changes; an id address, in any case, goes there with a 301 that keeps the query string, for the links of 12 November 2026 when pages were addressed by id, before Jamie chose the names again: "Approved: make the name addresses canonical again for signs and players, with id links redirecting to them"; `permalinks.ts`; a key that names no shown sign is a 404) (a breadcrumb to `/signs` and its state, the photos and Where on the left; the title, who found it and when, the heart, Share and Copy link, the first way on its plate, the caption, more ways and the app on the right; then each number with what it was read from, the older and newer sign in posting order, and nearby), `/players` (`players.tsx`: everyone with a sign or a badge, the most signs first and, among equals, the newest player by the day they started (Jamie, 2026-11-11), each with their signs, states and newest sign's math; never a count of badges and never a rank), a page per player at `/players/<handle>`, where their id address goes the same way (a breadcrumb to `/players`, playing since (`playingSince` in `players.tsx`, shared with `/players`), signs and states, their feed, badge cards, their signs as photos or `?view=map`; a player with no signs of their own has Ways found instead, one row per sign they solved on someone else's sign (the first way, a new way, or another player's way found too), and the page answers for a way found as for a sign or a badge, as the sitemap does; while Quiz is open it says they find the math with Quiz), and `/app` (`app-page.tsx`, where every "Get the app" goes: three screens of the app, Apple's App Store badge with a QR code for a reader on a computer, "Try the beta" (TestFlight, for early builds) as the second way in, getting started, questions, how to play). The app is on the App Store (`APP_STORE_URL` and `APP_STORE_ID` in `layout.tsx`, since 2026-11-11); every page but the sign-in link's carries Safari's Smart App Banner (`apple-itunes-app`, with the page's own address as `app-argument`). The badge is Apple's own black US English SVG from its marketing toolbox, kept as supplied in `app-store-badge.ts` and served at `/app/app-store-badge.svg`: never recolour or redraw it, and keep it at least 40 px tall (Apple's guidelines). The header is Map (`/`), Signs, Players and About, with the page you are on marked. The app's screens and the QR code are in `app-assets.ts`, which `npm run app-assets -- <camera> <sign> <home>` (`tools/app-assets.ts`) makes from three screenshots of the app as WebP (served at `/app/<name>.webp`) and from `APP_STORE_URL`; run it again when the link changes (a test checks it; with no screenshots named it keeps the screens and remakes only the code), and look at each screenshot first: this repo is public. `/about` tells the game's story in Jamie's words (its first sign is the Genesis sign's photo when that sign is shown), `/privacy` what is kept (backups included: deleted things leave them within a year) and that a report emails Jamie, `/rules` the house rules Jamie approved on 2026-11-10 (keep them word for word; the app's sign-in says signing in agrees to them), and `/support` (Help, the App Store's support link: who makes it, Send feedback and email, Delete my account (in the app and in Quiz) as `/privacy` says it, and links to the rules and privacy); all four are linked from every page's footer. `layout.tsx` is the frame (a skip link to each page's one `<main id="main">`, header, footer with the CC BY 4.0 line, colours light and dark, the logo), avatars and the plate. `FOLLOW` there names the accounts new signs are syndicated to, Mastodon (@roadsignmath@mastodon.social) and Bluesky (@roadsignmath.xyz): every page links them in its head and footer with `rel="me"` (how Mastodon verifies the profile's link to the site), `/about` says so under Follow along, and llms.txt lists them. The Bluesky handle is the domain itself, verified by the `_atproto` TXT record in the roadsignmath.xyz zone stack in projects-sysadmin; keep that record. The logo is the identity's primary horizontal lockup (the Radical Route mark and the Overpass wordmark as outlines), shown as a `<picture>`: the colour file on light, the white one on dark (`prefers-color-scheme`, like the colours), 44 px tall in the header, where its alt text "Road Sign Math" names the link home, and 32 px in the footer with an empty alt. The files and the Highway icon come from `brand.ts`, which `npm run brand -- design/brand/v1` (`tools/brand.ts`) generates from the package byte for byte (a test checks it still matches); the site serves the two lockups at `/brand/v1/<file>`, Highway as `/favicon.svg`, and Highway again at `/brand/road-sign-math-bimi.svg` in SVG Tiny PS, the logo mail apps that read BIMI show beside the sign-in email (the roadsignmath.xyz zone's `default._bimi` record in projects-sysadmin names that address, so keep the address and the format; the tool makes it from `highway.svg`, changing only the root, the title and the ids, and a test checks it draws the same). Don't edit, recolour or redraw the artwork: change the package and run the tool again. `icons.ts` draws Highway with sharp, on first ask, as `/favicon.ico`, `/apple-touch-icon.png` and the PNGs of `/site.webmanifest`, each the whole square canvas, opaque with its corners filled; the manifest's icons are `any`, never `maskable`, since the mark runs past a maskable icon's safe circle. An address no route takes gets `not-found.tsx`, the design's NotFound board (a Wrong Way sign, 404 = 4 × 101, the way back and the three newest signs), answered from `createApp`'s `notFound` so a sign or player that isn't there gets it too; a GET ending in a slash goes (301) to the address without it, never to `//host`. The API's 404s stay JSON. The micro.blog's old addresses (`old-links.ts`, Jamie, 2026-11-12: "redirect them where it makes sense") go with a 301, cached like a page: a post (`/2021/08/02/wurtsboro.html`, or `/wurtsboro` when one post had that name and it isn't a time) to its sign's `signUrl`, found at request time by the hash its seeded id carries; a post's photo (`/uploads/…`) to that photo; `/categories/<state>` to `/signs?state=` when that state has a shown sign; `/archive` and `/photos` to `/signs`; `/feed` to `/feed.xml`. A sign that is gone or not shown, and anything else, stays a 404. They are mounted last, so a page here always wins. The map (`map.ts`) is one picture, `/us-map.svg`, drawn from `us-map.ts`, which `npm run us-map` (`tools/us-map.ts`) generates from us-atlas in its 975 × 610 Albers USA frame; pins are placed with d3-geo's `geoAlbersUsa` and gathered into clusters by distance on that picture (`GATHER`), and a pin's size follows the map's width (`cqw`), so pins that are apart stay apart on any screen down to a phone. Pins and year chips are plain links (`?year=`, `?at=<slug>`), and Home's small inline script swaps the map's panel in place instead of reloading. That picture is the fallback and the share card's map: once Home has loaded, `home-map.ts` turns it into a map you can move (Jamie, 2026-11-11), Leaflet 1.9.4 and Leaflet.markercluster 1.5.3 from cdnjs, each checked by its SRI hash, OpenStreetMap's tiles (no key; attribution shown; darkened by CSS on dark; `/privacy` names it), every sign from `/signs.geojson` in numbered clusters, a card per dot linking its page, US and World views, and the year chips filtering the dots in place (`data-live` on the panel tells the swapping script to leave them). If anything fails to load the picture stays. Signs only the moving map can place leave the Not on the map list (`data-onmap`); the sign page's script only shows Share where the browser can share and Copy link where it can copy. The math on a sign's plate, its ways and every card is MathJax SVG drawn on the server, with the text as its label. `cards.tsx` holds what every list of signs shares (the card, the heart, the drawn separator dot, the sort chips). The app's four sorts are the site's too (`sorts.ts`), asked for as `?sort=latest|nearby|popular|complexity` on `/signs` (Home's chips link there): Popular reads the same heart counts as the API (one `HeartCounts` cache, given to both by `createApp`), Complexity uses `byComplexity`, and Nearby is sorted in the browser after the reader taps "Use my location" (`nearbyScript`, from each card's `data-lat` and `data-lng`), so the location never leaves the page and never goes in a link. Each filter on `/signs` counts within the other, and every link keeps the other choices. Tinylytics' counter is on every page but the sign-in link's (`tinylytics.ts`: the site id, the script, and the pixel the sign-in email carries), and fills each sign's heart (a `tinylytics_kudos` button at `/signs/<slug>`, on every card and the sign's page). A heart's key is the sign's address by slug (`heartPath` in `src/api/views.ts`): keep it, or every count starts again. Every link to a sign or player page comes from `signPath`/`signUrl` and `playerPath`/`playerUrl` there. Badges (`badges.tsx`) are cards on the player page, each a small inline SVG road sign with how it is earned and the sign that earned it; earned ones only, no count. Fonts are Overpass and Overpass Mono from Google Fonts. `/robots.txt` and `/sitemap.xml` are for search engines (robots allows `/api/v1/openapi.json`, which llms.txt points to, and blocks the rest of `/api/`): the sitemap lists Home, `/signs`, `/players`, `/app`, `/about`, `/privacy`, `/rules`, `/support`, `/data`, every shown sign (lastmod is its newest way, or when it was posted) and every player page that answers. `apple.ts` is the apple-app-site-association that opens the sign-in link and sign pages in the app. |
| `src/web/open.tsx` and its parts | The open web, mounted on the site (public, cached like the pages, `Access-Control-Allow-Origin: *` on every file): `data.ts` makes `/signs.json`, `/players.json` and `/signs.geojson` (shown signs and players with a page only, never an email; each file has `version`, `DATA_VERSION`, which goes up when a field is renamed, removed or changes meaning), `feeds.ts` the Atom and JSON Feed 1.1 of the newest 50 signs at `/feed.xml` and `/feed.json` and the same pair per player at `/players/<handle>/feed.*` (the id's address goes there with a 301; no tracking pixel). Micro.blog reads `/feed.json` and cross-posts each new sign to Mastodon and Bluesky, so every item in both feeds is a short post with no title (Atom's required title is empty; no summary): a titled item would go out as just its title and a link. The text is the sign's name and math, the caption, who found it, when and where, other ways, the sign's page as a bare link, then the photos with their alt text. Keep it near Bluesky's 300 characters, keep both feeds' items the same, and never change an item's id (the sign's address by slug: `feedItemId` in `src/api/views.ts`) or a feed's own Atom id (Home, or the player's address by handle), or micro.blog imports every sign again, `llms.ts` `/llms.txt` (llmstxt.org's parser shape) and `/llms-full.txt`, and `docs.tsx` the `/data` page that documents all of it, with a field list per file that `test/open.test.ts` checks against the files. Every page's head names the feeds and llms.txt as alternates, never the other JSON. CloudFront doesn't compress `application/atom+xml`, `application/feed+json` or `application/geo+json`; they go out uncompressed, small at this size. |
| `src/web/share.ts` | Share cards. Every sign, player and Home names its card on cards.thingelstad.com as its `og:image` (`https://cards.thingelstad.com/rsm/<path>.png?v=<v>`, Home `/rsm/index.png`; `<path>` is the page's own address, the sign's slug or the player's handle, `signCardPath` and `playerCardPath`: the card maker takes lowercase paths only), with its size and alt text; `v` is the first 10 hex of the SHA-256 of what the card shows, so a new way, photo or sign makes a new card, and the card maker draws only at the `v` the page names. The card maker reads the page's microformats, which `site.tsx` writes as `<data>` elements: a sign is an `h-entry` (`p-name`, `dt-published`, `u-photo`, `p-location`, `p-finder`, the first way as `p-math` and `p-tex`, `p-way-count`, `p-number`), a player an `h-card` with its own `u-url`, which the card maker matches to the address it fetched (`p-name`, `u-photo` or `p-avatar-color`, `p-sign-count`, `p-state-count`, `p-first-year`, `p-note`), and Home an `h-feed` (`p-name`, `p-kicker`, `p-summary`, `u-map` for `/us-map.svg`, a `p-pin` per pin as `x y signs` in percent of the map, and the counts). A field the card shows is added in both places: the builder's list here and the page's data. The card maker (jthingelstad/cards.thingelstad.com) ships first, so a page never names a card it can't draw. |
| `src/auth/` | Sign-in by email (link or code), tokens, and the account: name, bio, delete. |
| `src/mail/` | `Mailer`: SES live, files in `.data/mail/` for `npm run dev` (the text, and the HTML beside it), memory in tests. `signin.ts` is the sign-in email: a plain-text part and a designed HTML part (tables, inline styles, dark mode, no script; its one image is Tinylytics' pixel, the same for every email, so opens count per email, never per person) with the link and code escaped. |
| `src/posting/` | Uploads, posting a sign, ways, deleting, reports and blocks. |
| `src/edge-cache.ts` | How long CloudFront keeps the website: every page, open file and missing page's 404 says `s-maxage` a day (`PAGE_CACHE`), Popular (`?sort=popular`) six hours (`POPULAR_CACHE`, Jamie 2026-11-02: "at least 6 hours", since a website heart never reaches the server), browsers a minute. `PageChanges` wraps the store given to `createApp`: a request that runs a write that changes a page (signs, ways, players: `PAGE_WRITES`) clears the whole distribution (`/*`, one path) once, after the request; a failed clear is logged as `edge-cache` and the page is at most a day old. A new page-changing store method goes in `PAGE_WRITES`. Each release clears it too (`scripts/release.sh`), and a write straight to the live table (the seed's `--to live`) needs a clear by hand. The API's public reads stay at a minute. |
| `src/newsletter.ts` | The players' newsletter on Buttondown. Jamie, 2026-11-07: "include ALL players that we have in the system, add new players when they create account, delete players if they remove themselves". A new player is added at their first sign-in (`finishSignIn` in `app.ts`, and Quiz's `finish`) and a deleted one removed (`deleteMe`); both are best-effort, never in the way, and logged by outcome only, never by address. Tags (Jamie, 2026-11-12: "Approved: add Buttondown tags for Quiz players and tag the existing list once"): `app` and `quiz` say where a player has signed in, `first-era` marks the archive's 2005-2014 players (`isFirstEraPlayer`, by the time in their id). `newsletterAtSignIn` (`src/auth/account.ts`) adds a new player with the tag of where they signed in, and tags one already on the list the first time they sign in somewhere new, reading their tags and writing them back with the new one (Buttondown's update replaces the whole list), under the player's lease (`newsletterLease`; a busy one skips, to be tried at the next sign-in). The tags Buttondown confirmed are kept on the player (`newsletterTags`, private), so a missed one is tried again at the next sign-in there, and each session records where it was made (`via`). Tags are only added, never taken off; tags Buttondown refuses never keep a new player off the list (the add is `untagged`, and the tag isn't recorded). `/privacy` says the list notes whether you play in the app, Quiz or both. An add sends no collision header, so an address Buttondown already has, unsubscribed included, stays as it is: nobody is ever resubscribed. `npm run newsletter -- --to check|live` (`tools/newsletter-sync.ts`, the key through the environment) added the players from before, once, on the owner's go, and tags the list from the player rows and their sessions under the same lease; it writes nothing else to the table. Open and click tracking stay off: they record each reader. |
| `src/hearts.ts` | Hearts: hearting and taking back (our row plus a Tinylytics kudo, kept in step), every sign's count from one cached read of the site's kudos, and removing kudos when a sign or account goes. |
| `src/tinylytics.ts` | The Tinylytics API client (site 1525) with the full-access key from the runtime secret: kudos, and the app's screen views as hits. No key means `off`, never a crash; the key never reaches a log or an answer. |
| `src/moderation/` | `Moderator`: Claude live (`claude-haiku-5-5`), lets everything through in `npm run dev` without a key. |
| `src/photos.ts` | The two served sizes of a photo (1600 and 480 px JPEGs, no metadata; a profile photo 512 and 160 px square) and `PhotoStore`: S3 live, `.data/` for `npm run dev`, memory in tests. Only a shown sign's photos are under `p/`, which the site serves; a held or hidden sign's are under `held/`, which only its poster reads, through `GET /me/photos/{id}/{size}`. |
| `src/seed/` | Builds the launch set from the micro.blog export and `seed/microblog.json`, and the first-era signs from the archive and `seed/archive.json` (`archive.ts`). |
| `src/dev.ts` | The local server on port 8787, reading `.data/` (ignored by git), and Quiz, open, on 8788. |
| `src/server.ts` | The live server: `src/live.ts` wires the table, photo bucket, SES and the moderator from the stack's environment, and `src/listen.ts` serves on the address the platform gives. The moderator's and Tinylytics' keys are read from the runtime secret (`src/secrets.ts`). |
| `src/front.ts`, `src/quiz/` | Two fronts, one server. Quiz (`quiz.roadsignmath.xyz`, Jamie 2026-11-11) is its own CloudFront distribution in front of the same function: nothing cached, the `rsm_quiz` cookie forwarded, its own access log and the shared web ACL. Each distribution sets `X-RSM-Front` on its origin requests (`site` or `quiz`; CloudFront overwrites one a viewer sends), and `createApp` hands a request to `createQuiz` (`src/quiz/quiz.tsx`) when it says `quiz`, else to the site: Quiz never serves the site's pages or the API, and the site never serves Quiz's. The edge-cache middleware sits outside both, so a way found in Quiz clears the site's pages. Jamie opened it on 2026-11-12 (`QUIZ_OPEN`); switched off, every Quiz address answers a short noindex coming-soon page. Open (`quizOpen` in tests; `npm run dev` serves it on a second port, 8788), Quiz is server-drawn pages, the design's Quiz boards (`pages.tsx`): home, sign-in by email (`/signin`, the code page, the name page; the email's link lands on a page that changes nothing until its button posts, so a mail scanner can't use it up), a sign to solve at `/signs/<slug>` (its id address, and its `/found` and `/ways`, go there with a 301 that keeps the query; signed out, it goes to sign in carrying the sign as `to`, a checked slug, or an id from a link of 12 November 2026, through the code page, the email's link and the name page, and lands on that sign after; `/next` draws one at random from the shown signs with numbers that don't credit the player and that they haven't solved; Skip records nothing), what a send found (`/found`: a new way, the first way with Tag Team, or found too), the ways on a sign, the signs you've solved (`/solved`, only you see it), your profile (`/profile`, the header's face links it; Jamie, 2026-11-12: "The profile page should mimic similar fields to what we have in the iOS app"), and the end. The profile is the app's You and Settings on the web: your face and your page on the site (`playerUrl`, linked once the site has a page for you), the profile photo (a file upload through `setAvatar`, so it is squared from the middle, stripped and moderated as the app's is; Remove photo asks first, `removeAvatar`), name and bio (`updateMe`), your email (only you see it), Signs you've solved, Sign out, and Delete my account (`/profile/delete` asks first with the app's words, then `removePlayer`, the same code as `DELETE /me`, newsletter included, clears the cookie and lands on `/deleted`). Every face in Quiz is the player's photo from the site when they have one (`photoUrl`), else their coloured letter. A way goes through `solveSign` with `via: 'quiz'`, so the rules are the app's. The sign-in is the `rsm_quiz` cookie (`session.ts`): the app's token, HttpOnly, Secure, SameSite=Lax so a link from elsewhere arrives signed in; no GET changes anything and every POST must carry Quiz's own Origin. The solve page's one script is the keypad (`keypad.ts`: tiles and operator keys, no digits), which checks every tap with `checker.ts`, the browser bundle of `src/domain/equation.ts` that `npm run quiz-checker` (`tools/quiz-checker.ts`) makes; a test checks it was made from today's checker and answers as it does. Without scripts the form is a text field the server checks. The sign-in email says Quiz's words when Quiz sent it (`signInMail`'s `front`, pixel `/email/signin-quiz`). Photos, logos and the favicon come from the site's origin; Quiz serves no files. Every Quiz page but the sign-in link's loads Tinylytics' script with Quiz's own site (`QUIZ_TINYLYTICS_SITE` in `src/web/tinylytics.ts`), so its numbers stand apart from the website's; page views only, no events or hearts. While it is open, each site sign page with numbers has "Try this one in Quiz" (event `quiz.try`) to that sign in Quiz, and `/privacy` has a Quiz section (its one sign-in cookie, its own counting); `/privacy` and `/support` say Delete my account is on your profile in Quiz as well as in the app. Nothing counts or ranks. The certificate carries `quiz.<domain>`, the endpoint grant names both distributions (`tools/web-platform.ts`, which widens the site-only grant once and refuses any other), and the zone stack in projects-sysadmin holds Quiz's alias records (`QuizRecords` output). |
| `infra/` | The stacks: `template.yaml` (the app: web function, table, photos, mail, CloudFront (the site's distribution and Quiz's), the alarm topic), `deploy.yaml` (deploy roles and code bucket) and `backup.yaml` (monthly backups, each deleted after 330 days so a deleted photo, kept 30 days as an old version, leaves them within a year; applied by hand). Only the app stack deploys on merge. |
| `scripts/`, `deploy.sh` | The release: `build-release.sh` builds with no credentials, `release.sh` deploys and probes; `deploy.sh` runs both from the Mac. |
| `seed/microblog.json` | The 16 micro.blog signs: titles, finders, numbers, places, alt text, and each post's photos as the export names them (`uploads`, which the seed checks against the export and the old `/uploads/` addresses use). |
| `seed/archive.json` | What the first-era archive doesn't say: every sign's post time and found day with where each came from, corrections, and which photos to swap for a cleaner copy. |
| `tools/` | `export-api-contract.ts` (`npm run contract`), `us-map.ts` (`npm run us-map`), `app-assets.ts` (`npm run app-assets`), `brand.ts` (`npm run brand`), `seed-archive.ts` (`npm run seed:archive`), `seed-microblog.ts` (`npm run seed`), `newsletter-sync.ts` (`npm run newsletter`), `owner.ts` (`npm run owner`: hide or show a sign, place one on the map, remove a way or a player), `quiz-checker.ts` (`npm run quiz-checker`), and the release tools: `build-server.ts` (`npm run build:server`), `package-native.ts`, `native-artifacts.ts`, `web-platform.ts`, `release-probe.ts`, all run through `release-cli.ts`. |
| `docs/DEPLOY.md` | How it is hosted, how a release works, and the first deploy step by step. |
| `contracts/` | `api-surface.json` (OpenAPI 3.1), `api-versions.json` (each version's digest), `equation-vectors.json`. |
| `design/brand/v1/` | The Road Sign Math identity package 1.0 as the designer supplied it (`START-HERE.txt` first): the five icons, the logos and wordmarks as outlined SVG and PNG, the layers, previews, and Overpass with its SIL Open Font License. The site uses the horizontal lockups and Highway through `src/web/brand.ts`. Keep the package as supplied; a new version goes in its own folder. |
| `test/` | `node --test` with tsx. `test/support/` has a fake DynamoDB and fictional fixtures. |

## The table

One DynamoDB table with string keys `pk` and `sk` and no indexes. Every list is read whole
and filtered in memory; at this size that is cheaper and simpler than indexes.

| pk | sk | holds |
| --- | --- | --- |
| `SIGNS` | `SIGN#<signId>` | a sign |
| `SIGN#<signId>` | `WAY#<createdAt>#<wayId>` | a way to make it true |
| `PLAYERS` | `PLAYER#<playerId>` | a player |
| `EMAIL#<sha256>` | `EMAIL` | the player id for an email address |
| `HANDLE#<handle>` | `HANDLE` | the player id holding a handle |
| `SLUG#<slug>` | `SLUG` | the sign id holding a slug |
| `SIGN#<signId>` | `MATH#<sha256>` | the way id holding that math on the sign |
| `SIGN#<signId>` | `SAME#<sha256>` | the way id holding that way in any order |
| `SIGN#<signId>` | `ALSO#<wayId>#<playerId>` | a player who also found that way |
| `SIGN#<signId>` | `REPORT#<playerId>` | a player's report of that sign |
| `SIGN#<signId>` | `DUPLICATE#<playerId>` | a player's word that it is the same as another sign |
| `PLAYER#<playerId>` | `SESSION#<sha256>` | a signed-in app (expires) |
| `PLAYER#<playerId>` | `UPLOAD#<photoId>` | a photo uploaded, not yet posted (expires) |
| `PLAYER#<playerId>` | `BLOCK#<playerId>` | a player they blocked |
| `PLAYER#<playerId>` | `HEART#<signId>` | a sign they hearted, and its kudo's uid |
| `PLAYER#<playerId>` | `POST#<idempotencyKey>` | the sign a post's key made (expires) |
| `LOGIN#<loginId>` | `LOGIN` | a sign-in in progress (expires) |
| `LIMIT#<key>` | `<windowStart>` | a rate-limit count (expires) |
| `LEASE#<key>` | `LEASE` | one request's hold on what the key names (expires) |

The email, handle, slug and math rows are claimed with conditional writes, so two requests at
once can't give one address two players, one handle or slug to two, or one sign the same way
twice. A post takes its uploads the same way, so two posts can't share a photo. A sign changes field by field
(`updateSign`), so a new way can't undo a report's hide, and a new way counts itself in one
write with its math and its row (`addWay`, one transaction). A co-find is kept only while its way
is there (`addCoFind` checks the way's row in the same transaction). Rows that expire carry `expiresAt` (epoch seconds) for the table's TTL, and every read checks
it too, since TTL deletes late. `test/docs.test.ts` checks this table against
`src/store/dynamo.ts`.

## The API

- Everything is under `/api/v1`, JSON with snake_case keys, an `API-Version` header on every
  answer, and errors as `{"error": {"code", "message"}}`.
- A route is a row in `src/api/contract.ts` plus a handler in `src/api/app.ts` with the same
  operation id. Any change to the surface bumps `API_VERSION` and runs `npm run contract`;
  the tool refuses a changed surface under a recorded version.
- **Sign-in** (`src/auth/`): `POST /auth/start` emails a link and a 6-digit code to anyone;
  `POST /auth/verify` takes either and returns a bearer token `rsm_<playerId>_<secret>`.
  Only hashes are stored. The first sign-in makes a player with no name; the first name
  sets the handle, which never changes after. Limits are in `src/auth/auth.ts`. A try at the
  code is counted before the code is compared, in one conditional write, so five is the most a
  login ever gets however the guesses arrive. `PATCH /me` writes only what differs from what is
  kept (a write clears the edge) and takes `LIMITS.profileEditsADay` changes a day.
- A request with an `Authorization` header is never cached, and a bad token is a 401 even on
  a public read.
- `DELETE /me` removes the player, their profile photo, the signs they posted (with their photos and hearts), their
  ways, reports (duplicate ones too) and hearts on other signs, their co-finds and every co-find on their ways,
  and their place in other signs' finders. Their
  hearts' kudos go first: if Tinylytics can't take one back, it is a 503 and nothing is deleted.
  It holds the player's heart lease throughout (a 409 while one of their hearts is changing).
- **Duplicate reports** (`reportDuplicate` in `src/posting/posting.ts`): `POST /signs/{id}/duplicate`,
  signed in, says a sign is the same road sign as another one posted separately (`same_as`, an
  optional note). Jamie, 2026-11-07: "A duplicate sign should be submitted as a 'report a
  duplicate', similar to the other report function… we can figure out later what we do with
  that." So it is only kept, one per player per sign, and never goes to the moderator.
- **Reports reach Jamie** (`src/reports.ts`; Jamie, 2026-11-10): each new report of a sign, once
  Claude has looked at it, and each duplicate report is emailed to `FEEDBACK_TO`, with the sign's
  title and link, the reason or note, Claude's verdict (hidden or kept) and the reporter's name and
  handle, never an email address. Best-effort: the report is decided and saved first, a mail that
  fails changes nothing, and it is logged as `report-mail` by outcome only. A repeat of a player's
  report sends nothing. `/privacy` says a report emails Jamie.
- **The owner's commands** (`src/owner.ts`, `npm run owner`, `tools/owner.ts`; Jamie, 2026-11-10:
  "a Mac-side script to hide a sign or remove a player. No admin website."): `hide-sign <slug>`
  (the state an upheld report leaves, `hideSign` in `posting.ts`), `unhide-sign <slug>`,
  `set-place <slug>` (coordinates, label, state and whether the pin is approximate; Jamie, 2026-11-11, for
  the signs abroad and Gross Vehicle Weight), `remove-way <slug> --way <id>` (one way off a sign, with its
  co-finds, the sign's count and first way kept in step; Jamie, 2026-11-12) and `remove-player <handle>` (`removePlayer` in `account.ts`, the same code as `DELETE /me`,
  newsletter included), each `--to check|live`. `check` only reads; `live` writes the live table
  on the owner's word alone and clears the edge once. Never run `--to live` to test anything:
  `test/owner.test.ts` runs it against the memory store. [`docs/DEPLOY.md`](docs/DEPLOY.md) has the
  usage.
- **Addresses**: every `url` (signs, pins, players, a badge's sign) is the page by name, `/signs/<slug>`
  and `/players/<handle>`. `GET /signs/{id}` takes an id in any case or a slug, and `GET /players/{handle}`
  a handle or an id in any case (1.14.0), so the id links of 12 November 2026 still open in the app.
- **Hearts** (`src/hearts.ts`): `PUT` and `DELETE /signs/{id}/heart`, signed in, one per player
  per sign, idempotent. A heart is a Tinylytics kudo at `/signs/<slug>`, the same path as the
  website's kudos button, so `hearts` on every sign (summary, detail, pin) counts both; it is
  null when the counts can't be read. `hearted` is the signed-in reader's own, from our rows,
  and null signed out. Writing a heart puts our row, then the kudo; if Tinylytics fails the kudo
  is taken back too and the row removed, so a 503 changes nothing (if taking it back fails as
  well, the row stays and a later DELETE removes both). A change holds the player's heart lease
  with a holder of its own (a 409 while another is in flight), so a player's requests and their
  account's delete can't cross, and heart rows are read strongly consistent. The kudo's uid is a
  hash of the player and sign ids. Deleting a sign removes every kudo at its path (the
  website's too) before the sign goes and again after, and a heart checks its sign is still
  there once its kudo is made, so a later sign with the slug starts at none. Counts are read once a minute per instance;
  Tinylytics allows the key 1,000 calls an hour.
- **Popular** (`GET /signs/popular`, the app's third Home tab): at most 50 signs, the most
  hearts first, counting every heart a sign has had; ties and the unhearted come newest first
  (Jamie, 2026-10-31: "all-time hearts, newest breaks ties, unhearted signs last, app first").
  Without counts it is the newest. `popular` is a reserved slug, like `near` and `similar`.
- **Complexity** (`GET /signs/complex`, the app's and the site's fourth sort; `src/domain/complexity.ts`):
  at most 50 signs, the most complex math first. Jamie asked Claude to design it (2026-10-31: "it
  should be based on some scoring of the math operators used and how many of them… more complex
  math operators yields more complex sign"). Each operator in a way counts once, weighted: + and −
  1, × 2, ÷ 3, a negative 2, √ and powers 4, ! 5; numbers, brackets and = count nothing. A sign
  is its most complex way the reader sees, so a harder way found later moves it up; ties come
  newest first and unsolved signs last, at 0. Each sign in the answer carries its `complexity`
  for the app, but no page shows it: it orders signs by their math and is never a player's score.
  `complex` is a reserved slug.
- **Badges** (`src/domain/badges.ts`): 30 little road signs on five shelves (firsts, places,
  math, seasons, secret). Nothing about them is stored: they are worked out on every read from
  the shown signs and the ways on them that the reader sees (a block leaves out the blocked
  player's ways), so a badge follows its sign. A sign's badges go to its poster and every
  finder who plays; a way's go to its author. Tag Team (Jamie, 2026-11-11) is the first way on a
  sign posted unsolved, by a player the sign doesn't credit, and its poster earns it too; Cracked
  It is a sign's second way, by a player it doesn't credit who didn't write the first (the poster's
  own second way is Another Way). The app draws Tag Team's merge sign by its id; builds before it
  draw the firsts plate with its text mark, `1+1`. Each earned badge carries the sign and day that
  first earned it, and stepped ones (States, Mile Markers) the step reached. `GET /badges` is
  the catalog, with the five secret ones as `secret: true` and no name or how; `badges` is on
  `GET /players/{handle}` and `GET /me`; posting a sign or a way answers with `unlocked`, what
  it earned that wasn't earned before. Others see earned badges only, never a count. Reading
  them lists the ways on every shown sign, one query each: fine at the launch set's size,
  worth a cache before it gets big.
- **App views**: `POST /app/views` (public) passes up to 20 screen paths to Tinylytics as hits
  with source `ios-app`, the request's User-Agent and CloudFront's viewer country, and no IP or
  visitor id. It waits on Tinylytics two seconds at most and answers 202 either way.
- **Feedback** (`src/feedback.ts`): `POST /feedback`, signed in, emails the player's message to
  `FEEDBACK_TO` in the stack's environment (admin@thingelstad.com; Jamie, 2026-10-31: "Route
  the inbound requests to admin@thingelstad.com"), with their name, handle, page, sign count,
  the app's `app` line and the time in US Central. Their email goes only when `reply_ok` is
  true, and then only as the Reply-To, never in the text. Ten a day per player; mail that
  can't be sent is a 503 (it still counts toward the ten). `npm run dev` writes it to
  `.data/mail/` like the sign-in email.
- **Solving** (`solveSign` in `src/posting/posting.ts`): `POST /signs/{id}/solve`, signed in, takes
  a way like `POST /signs/{id}/ways` and never answers a repeat with a 409. A way new to the sign is
  added (`result: "new_way"`, with `unlocked` like a posted way); the same math as another
  player's way is a co-find (`result: "also_found"`, with that way and `unlocked: []`): the way
  stays its first finder's, and the solver is added to its `also_found_by`, once. Co-finds earn no
  badges. A reordering of a way there earns nothing (Jamie, 2026-11-11: no credit and no "also
  found by"), so it is the same 409 `REORDERED` as a way; your own way again is a 409 (`YOURS`, no
  full stop). Both count toward
  `LIMITS.waysADay`. `via` records `app` or `quiz`. Every way (`GET /signs/{id}` and the sign page)
  carries `also_found_by`, oldest first, less blocked players and players with no name. A co-find
  goes with its way and its sign. `POST /signs/{id}/ways` is unchanged for the App Store app.
- **Activity** (`src/activity.ts`): `GET /me/activity`, signed in, is what's new on your signs
  for the app's You tab: the ways other players found, the ways already there they found too
  (`also_found`, with the way; the App Store app leaves out kinds it doesn't know) and the hearts
  they gave in the last 30 days, newest first, at most 100. Your signs are the ones you posted or are a finder of, in
  any state. Your own ways and hearts and anything by a player you blocked (signs they posted
  included) are left out, and
  so are the website's kudos, which have no player. Showing who hearted is Jamie's design
  (2026-10-31). It reads every player's heart rows, one query each: fine at this size.
- **Posting** (`src/posting/`): `POST /photos` takes the photo itself and keeps it under
  `uploads/` for a day; `POST /signs` posts up to four of them. A held post's photos never go
  under `p/`, and a hidden sign's leave it (with CloudFront's cached copies). An `Idempotency-Key` makes a
  retried post one sign. A post or report the moderator can't answer is a 503 and changes
  nothing. Daily limits are in `LIMITS` in `src/api/contract.ts`.
- **Profile photos** (`src/auth/account.ts`): `PUT /me/avatar` takes the photo itself, crops it
  square from its middle (the app sends it cropped), keeps 512 and 160 px JPEGs with no metadata,
  and puts them straight under `p/` once the moderator says ok (a 422 `refused` with its reason
  when not, a 503 when it can't answer); the photo it replaces is removed. `DELETE /me/avatar`
  takes it down. The player row holds the photo's id (`avatar`); `avatar_url` and
  `avatar_thumb_url` are on every player (`/me`, `/players`, `/players/{handle}`), and the site
  draws it wherever a face was a coloured letter. Clients find a finder's or a way's face by
  handle in `/players`. `DELETE /me` removes it too.

## The launch set

The 16 signs posted to the micro.blog from 2021 to 2025 are the first signs. The export stays
outside this repo; `npm run seed -- --export <folder> --to plan` checks `seed/microblog.json`
against it, `--to local` fills `.data/` for `npm run dev`, and `--to live` writes the live
table and photo bucket (a live write: only on the owner's go; a sign already there is left alone). Their numbers and alt text come
from looking at each photo. Each pin sits on the town the post or the sign names, so every one
is approximate, and Gross Vehicle Weight has none. Don't change what a photo shows without
looking at it.

## Working here

- `npm run verify` (format, lint, types, tests) before every push; CI runs the same.
- Tests use fictional players and signs. Real people's details stay out of tests; the one
  check on `seed/microblog.json` treats it as data and names no one.
- Work on a branch in a worktree and open a PR; Codex reviews every PR. Read its findings and
  fix or answer each one.
- Node 24, TypeScript run directly by tsx and Node's type stripping. The one build is the
  release's: esbuild bundles `src/server.ts` into the code zip (`npm run build:server`).

## Deploying

[`docs/DEPLOY.md`](docs/DEPLOY.md) is the whole story. In short:

- Once the first deploy is done and the repository variable `RELEASES` is `on`, a merge to
  main releases it: `deploy` follows a green
  `validate`, builds with no credentials, and runs `scripts/release.sh` as the GitHub deploy
  role. Roll back by reverting the merge. `./deploy.sh` does the same from the Mac.
- The first deploy, the deploy and backup stacks (IAM), the alerts-queue policy, mail and site
  DNS records, the domain move and seeding live data each need the owner's go.
- `npm run seed:archive -- --to live` loaded the first era on the owner's go (2026-11-07); `--to check`
  reads the live table and says what a load would do. Old addresses are read into memory only: never
  print, log or save them.
- The runtime secret holds the moderator's key (`ANTHROPIC_API_KEY`), the Tinylytics key
  (`TINYLYTICS_API_KEY`) and the newsletter's Buttondown key (`BUTTONDOWN_API_KEY`). The owner keeps it by hand; never read or write its values. Never test
  hearts or app views against live Tinylytics with writes: tests use `test/support/tinylytics.ts`.
- No account id, ARN, zone id or other resource id goes in this repo or its Actions logs:
  scripts read them from the stacks and mask them in Actions.
- `validate` runs `cfn-lint` 1.57.2 on `infra/`; run it before pushing a template change:
  `pipx run --spec cfn-lint==1.57.2 cfn-lint infra/template.yaml infra/deploy.yaml infra/backup.yaml`.
