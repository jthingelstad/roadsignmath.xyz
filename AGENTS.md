# Agent guide: roadsignmath.xyz

The server and website for Road Sign Math, a road trip game: find a road sign whose numbers
make a true equation, photograph it, write the math, post it. `README.md` is the overview for
people; this file is the working rules. `CLAUDE.md` is a symlink to this file.

This repo is **public**. It never holds secrets, signing files, player emails, cloud account
ids or ARNs, local paths, or photos of plates or faces that weren't meant to be shared.

## The game, as built

- **No points.** No scores, scoreboards, ranks, judges or rules pages.
- **A light check.** A way is accepted when the math is true and every number in it is one of
  the sign's checked numbers, each used no more often than the sign shows it. Using every
  number is encouraged, not required. `src/domain/equation.ts` is the checker;
  `contracts/equation-vectors.json` holds the cases the server and the iPhone app both pass,
  including each way's LaTeX (`tex`): ÷ is a stacked fraction. The site draws it as SVG with
  MathJax on the server (`src/web/math.ts`); the app draws the same LaTeX with SwiftMath
  and checks its own LaTeX writer against these vectors.
- **Public reads, signed-in writes.** Only `shown` signs are public; a player also sees their
  own held and hidden signs. A player's email never leaves the server.
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
| `src/web/` | The website, as the design draws it (Hono JSX, public, cached a minute; no sign-in). `site.tsx` has the pages: Home at `/` (the map of every shown sign with the year filter and the picked place's signs, who's playing, the latest signs, how to play, the app), a page per sign at `/signs/<slug>` (photo, the math on its plate, the ways, the numbers, where, nearby) and a page per player at `/players/<handle>` (stats, badges, their signs as photos or `?view=map`). `/about` tells the game's story in Jamie's words (its first sign is the Genesis sign's photo when that sign is shown) and `/privacy` what is kept; both are linked from every page's footer. `layout.tsx` is the frame (header, footer, colours light and dark, the sign-plate logo also served as `/favicon.svg`), avatars and the plate. The map (`map.ts`) is one picture, `/us-map.svg`, drawn from `us-map.ts`, which `npm run us-map` (`tools/us-map.ts`) generates from us-atlas in its 975 × 610 Albers USA frame; pins are placed with d3-geo's `geoAlbersUsa` and gathered into clusters by distance on that picture (`GATHER`), and a pin's size follows the map's width (`cqw`), so pins that are apart stay apart on any screen down to a phone. Pins and year chips are plain links (`?year=`, `?at=<slug>`), and Home's small inline script swaps the map's panel in place instead of reloading; the sign page's script only shows Copy link. The math on a sign's plate and ways is MathJax SVG drawn on the server; cards carry the text. Tinylytics' counter is on every page but the sign-in link's (`tinylytics.ts`: the site id, the script, and the pixel the sign-in email carries), and fills each sign's heart (a `tinylytics_kudos` button at `/signs/<slug>`, on every card and the sign's page). Badges (`badges.tsx`) are small inline SVG road signs, earned ones only, no count. Fonts are Overpass and Overpass Mono from Google Fonts. `/robots.txt` and `/sitemap.xml` are for search engines (robots allows `/api/v1/openapi.json`, which llms.txt points to, and blocks the rest of `/api/`): the sitemap lists Home, `/about`, `/privacy`, `/data`, every shown sign (lastmod is its newest way, or when it was posted) and every player page that answers. `apple.ts` is the apple-app-site-association that opens the sign-in link and sign pages in the app. |
| `src/web/open.tsx` and its parts | The open web, mounted on the site (public, cached a minute, `Access-Control-Allow-Origin: *` on every file): `data.ts` makes `/signs.json`, `/players.json` and `/signs.geojson` (shown signs and players with a page only, never an email; each file has `version`, `DATA_VERSION`, which goes up when a field is renamed, removed or changes meaning), `feeds.ts` the Atom and JSON Feed 1.1 of the newest 50 signs at `/feed.xml` and `/feed.json` and the same pair per player at `/players/<handle>/feed.*` (no tracking pixel), `llms.ts` `/llms.txt` (llmstxt.org's parser shape) and `/llms-full.txt`, and `docs.tsx` the `/data` page that documents all of it, with a field list per file that `test/open.test.ts` checks against the files. Every page's head names the feeds and llms.txt as alternates, never the other JSON. CloudFront doesn't compress `application/atom+xml`, `application/feed+json` or `application/geo+json`; they go out uncompressed, small at this size. |
| `src/web/share.ts` | Share cards. Every sign, player and Home names its card on cards.thingelstad.com as its `og:image` (`https://cards.thingelstad.com/rsm/<path>.png?v=<v>`, Home `/rsm/index.png`), with its size and alt text; `v` is the first 10 hex of the SHA-256 of what the card shows, so a new way, photo or sign makes a new card, and the card maker draws only at the `v` the page names. The card maker reads the page's microformats, which `site.tsx` writes as `<data>` elements: a sign is an `h-entry` (`p-name`, `dt-published`, `u-photo`, `p-location`, `p-finder`, the first way as `p-math` and `p-tex`, `p-way-count`, `p-number`), a player an `h-card` with its own `u-url` (`p-name`, `u-photo` or `p-avatar-color`, `p-sign-count`, `p-state-count`, `p-first-year`, `p-note`), and Home an `h-feed` (`p-name`, `p-kicker`, `p-summary`, `u-map` for `/us-map.svg`, a `p-pin` per pin as `x y signs` in percent of the map, and the counts). A field the card shows is added in both places: the builder's list here and the page's data. The card maker (jthingelstad/cards.thingelstad.com) ships first, so a page never names a card it can't draw. |
| `src/auth/` | Sign-in by email (link or code), tokens, and the account: name, bio, delete. |
| `src/mail/` | `Mailer`: SES live, files in `.data/mail/` for `npm run dev` (the text, and the HTML beside it), memory in tests. `signin.ts` is the sign-in email: a plain-text part and a designed HTML part (tables, inline styles, dark mode, no script; its one image is Tinylytics' pixel, the same for every email, so opens count per email, never per person) with the link and code escaped. |
| `src/posting/` | Uploads, posting a sign, ways, deleting, reports and blocks. |
| `src/hearts.ts` | Hearts: hearting and taking back (our row plus a Tinylytics kudo, kept in step), every sign's count from one cached read of the site's kudos, and removing kudos when a sign or account goes. |
| `src/tinylytics.ts` | The Tinylytics API client (site 1525) with the full-access key from the runtime secret: kudos, and the app's screen views as hits. No key means `off`, never a crash; the key never reaches a log or an answer. |
| `src/moderation/` | `Moderator`: Claude live (`claude-haiku-5-5`), lets everything through in `npm run dev` without a key. |
| `src/photos.ts` | The two served sizes of a photo (1600 and 480 px JPEGs, no metadata; a profile photo 512 and 160 px square) and `PhotoStore`: S3 live, `.data/` for `npm run dev`, memory in tests. Only a shown sign's photos are under `p/`, which the site serves; a held or hidden sign's are under `held/`, which only its poster reads, through `GET /me/photos/{id}/{size}`. |
| `src/seed/` | Builds the launch set from the micro.blog export and `seed/microblog.json`. |
| `src/dev.ts` | The local server on port 8787, reading `.data/` (ignored by git). |
| `src/server.ts` | The live server: `src/live.ts` wires the table, photo bucket, SES and the moderator from the stack's environment, and `src/listen.ts` serves on the address the platform gives. The moderator's and Tinylytics' keys are read from the runtime secret (`src/secrets.ts`). |
| `infra/` | The stacks: `template.yaml` (the app: web function, table, photos, mail, CloudFront, alarms), `deploy.yaml` (deploy roles and code bucket) and `backup.yaml` (monthly backups). Only the app stack deploys on merge. |
| `scripts/`, `deploy.sh` | The release: `build-release.sh` builds with no credentials, `release.sh` deploys and probes; `deploy.sh` runs both from the Mac. |
| `seed/microblog.json` | The 16 micro.blog signs: titles, finders, numbers, places, alt text. |
| `tools/` | `export-api-contract.ts` (`npm run contract`), `us-map.ts` (`npm run us-map`), `seed-microblog.ts` (`npm run seed`), and the release tools: `build-server.ts` (`npm run build:server`), `package-native.ts`, `native-artifacts.ts`, `web-platform.ts`, `release-probe.ts`, all run through `release-cli.ts`. |
| `docs/DEPLOY.md` | How it is hosted, how a release works, and the first deploy step by step. |
| `contracts/` | `api-surface.json` (OpenAPI 3.1), `api-versions.json` (each version's digest), `equation-vectors.json`. |
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
| `SIGN#<signId>` | `REPORT#<playerId>` | a player's report of that sign |
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
write with its math and its row (`addWay`, one transaction). Rows that expire carry `expiresAt` (epoch seconds) for the table's TTL, and every read checks
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
  sets the handle, which never changes after. Limits are in `src/auth/auth.ts`.
- A request with an `Authorization` header is never cached, and a bad token is a 401 even on
  a public read.
- `DELETE /me` removes the player, their profile photo, the signs they posted (with their photos and hearts), their
  ways, reports and hearts on other signs, and their place in other signs' finders. Their
  hearts' kudos go first: if Tinylytics can't take one back, it is a 503 and nothing is deleted.
  It holds the player's heart lease throughout (a 409 while one of their hearts is changing).
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
- **Badges** (`src/domain/badges.ts`): 28 little road signs on five shelves (firsts, places,
  math, seasons, secret). Nothing about them is stored: they are worked out on every read from
  the shown signs and the ways on them that the reader sees (a block leaves out the blocked
  player's ways), so a badge follows its sign. A sign's badges go to its poster and every
  finder who plays; a way's go to its author. Each earned badge carries the sign and day that
  first earned it, and stepped ones (States, Mile Markers) the step reached. `GET /badges` is
  the catalog, with the five secret ones as `secret: true` and no name or how; `badges` is on
  `GET /players/{handle}` and `GET /me`; posting a sign or a way answers with `unlocked`, what
  it earned that wasn't earned before. Others see earned badges only, never a count. Reading
  them lists the ways on every shown sign, one query each: fine at the launch set's size,
  worth a cache before it gets big.
- **App views**: `POST /app/views` (public) passes up to 20 screen paths to Tinylytics as hits
  with source `ios-app`, the request's User-Agent and CloudFront's viewer country, and no IP or
  visitor id. It waits on Tinylytics two seconds at most and answers 202 either way.
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
- The runtime secret holds the moderator's key (`ANTHROPIC_API_KEY`) and the Tinylytics key
  (`TINYLYTICS_API_KEY`). The owner keeps it by hand; never read or write its values. Never test
  hearts or app views against live Tinylytics with writes: tests use `test/support/tinylytics.ts`.
- No account id, ARN, zone id or other resource id goes in this repo or its Actions logs:
  scripts read them from the stacks and mask them in Actions.
- `validate` runs `cfn-lint` 1.57.2 on `infra/`; run it before pushing a template change:
  `pipx run --spec cfn-lint==1.57.2 cfn-lint infra/template.yaml infra/deploy.yaml infra/backup.yaml`.
