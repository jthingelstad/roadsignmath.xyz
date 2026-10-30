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
  if it agrees), and writes each photo's alt text in the same call. A block hides a player's
  signs and ways from the one who blocked them. What counts as objectionable (`POLICY`) is the
  owner's call: change its words only with the owner's go.
- Product calls (what counts, moderation, what players are promised, who sees what) are the
  owner's. Ship the factual fix and ask about the policy half.

## Layout

| Path | What |
| --- | --- |
| `src/domain/` | The data model (`types.ts`), the equation checker, ids and slugs, miles. No I/O. |
| `src/store/` | `Store`, with `MemoryStore` (tests, `npm run dev`) and `DynamoStore` (the live table). |
| `src/api/` | `/api/v1` on Hono. `contract.ts` is the route table, limits and errors; `openapi.ts` describes it; `views.ts` makes the JSON. |
| `src/web/` | The website's pages (`site.tsx`, Hono JSX): every shown sign at `/` and one page per sign at `/signs/<slug>`, public and cached a minute. The math is MathJax SVG drawn on the server, no script in the page. The designed pages (map, players, sign-in) come later. |
| `src/auth/` | Sign-in by email (link or code), tokens, and the account: name, bio, delete. |
| `src/mail/` | `Mailer`: SES live, files in `.data/mail/` for `npm run dev`, memory in tests. |
| `src/posting/` | Uploads, posting a sign, ways, deleting, reports and blocks. |
| `src/moderation/` | `Moderator`: Claude live (`claude-haiku-5-5`), lets everything through in `npm run dev` without a key. |
| `src/photos.ts` | The two served sizes of a photo (1600 and 480 px JPEGs, no metadata) and `PhotoStore`: S3 live, `.data/` for `npm run dev`, memory in tests. Only a shown sign's photos are under `p/`, which the site serves; a held or hidden sign's are under `held/`, which only its poster reads, through `GET /me/photos/{id}/{size}`. |
| `src/seed/` | Builds the launch set from the micro.blog export and `seed/microblog.json`. |
| `src/dev.ts` | The local server on port 8787, reading `.data/` (ignored by git). |
| `src/server.ts` | The live server: `src/live.ts` wires the table, photo bucket, SES and the moderator from the stack's environment, and `src/listen.ts` serves on the address the platform gives. The moderator's key is read from the runtime secret (`src/secrets.ts`). |
| `infra/` | The stacks: `template.yaml` (the app: web function, table, photos, mail, CloudFront, alarms), `deploy.yaml` (deploy roles and code bucket) and `backup.yaml` (monthly backups). Only the app stack deploys on merge. |
| `scripts/`, `deploy.sh` | The release: `build-release.sh` builds with no credentials, `release.sh` deploys and probes; `deploy.sh` runs both from the Mac. |
| `seed/microblog.json` | The 16 micro.blog signs: titles, finders, numbers, places, alt text. |
| `tools/` | `export-api-contract.ts` (`npm run contract`), `seed-microblog.ts` (`npm run seed`), and the release tools: `build-server.ts` (`npm run build:server`), `package-native.ts`, `native-artifacts.ts`, `web-platform.ts`, `release-probe.ts`, all run through `release-cli.ts`. |
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
- `DELETE /me` removes the player, the signs they posted (with their photos), their ways and
  reports on other signs, and their place in other signs' finders.
- **Posting** (`src/posting/`): `POST /photos` takes the photo itself and keeps it under
  `uploads/` for a day; `POST /signs` posts up to four of them. A held post's photos never go
  under `p/`, and a hidden sign's leave it (with CloudFront's cached copies). An `Idempotency-Key` makes a
  retried post one sign. A post or report the moderator can't answer is a 503 and changes
  nothing. Daily limits are in `LIMITS` in `src/api/contract.ts`.

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
- The runtime secret holds the moderator's key. The owner keeps it by hand; never read or write
  its value.
- No account id, ARN, zone id or other resource id goes in this repo or its Actions logs:
  scripts read them from the stacks and mask them in Actions.
- `validate` runs `cfn-lint` 1.57.2 on `infra/`; run it before pushing a template change:
  `pipx run --spec cfn-lint==1.57.2 cfn-lint infra/template.yaml infra/deploy.yaml infra/backup.yaml`.
