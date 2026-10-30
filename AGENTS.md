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
  `contracts/equation-vectors.json` holds the cases the server and the iPhone app both pass.
- **Public reads, signed-in writes.** Only `shown` signs are public. A player's email never
  leaves the server.
- Product calls (what counts, moderation, what players are promised, who sees what) are the
  owner's. Ship the factual fix and ask about the policy half.

## Layout

| Path | What |
| --- | --- |
| `src/domain/` | The data model (`types.ts`), the equation checker, ids and slugs, miles. No I/O. |
| `src/store/` | `Store`, with `MemoryStore` (tests, `npm run dev`) and `DynamoStore` (the live table). |
| `src/api/` | `/api/v1` on Hono. `contract.ts` is the route table, limits and errors; `openapi.ts` describes it; `views.ts` makes the JSON. |
| `src/auth/` | Sign-in by email (link or code), tokens, and the account: name, bio, delete. |
| `src/mail/` | `Mailer`: SES live, files in `.data/mail/` for `npm run dev`, memory in tests. |
| `src/photos.ts` | The two served sizes of a photo (1600 and 480 px JPEGs, no metadata). |
| `src/seed/` | Builds the launch set from the micro.blog export and `seed/microblog.json`. |
| `src/dev.ts` | The local server on port 8787, reading `.data/` (ignored by git). |
| `seed/microblog.json` | The 16 micro.blog signs: titles, finders, numbers, places, alt text. |
| `tools/` | `export-api-contract.ts` (`npm run contract`), `seed-microblog.ts` (`npm run seed`). |
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
| `PLAYER#<playerId>` | `SESSION#<sha256>` | a signed-in app (expires) |
| `LOGIN#<loginId>` | `LOGIN` | a sign-in in progress (expires) |
| `LIMIT#<key>` | `<windowStart>` | a rate-limit count (expires) |

The email and handle rows are claimed with conditional writes, so two requests at once can't
give one address two players or two players one handle. Rows that expire carry `expiresAt` (epoch seconds) for the table's TTL, and every read checks
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
- `DELETE /me` removes the player, the signs they posted, their ways on other signs and their
  place in other signs' finders.

## The launch set

The 16 signs posted to the micro.blog from 2021 to 2025 are the first signs. The export stays
outside this repo; `npm run seed -- --export <folder> --to plan` checks `seed/microblog.json`
against it, and `--to local` fills `.data/` for `npm run dev`. Their numbers and alt text come
from looking at each photo. Each pin sits on the town the post or the sign names, so every one
is approximate, and Gross Vehicle Weight has none. Don't change what a photo shows without
looking at it.

## Working here

- `npm run verify` (format, lint, types, tests) before every push; CI runs the same.
- Tests use fictional players and signs. Real people's details stay out of tests; the one
  check on `seed/microblog.json` treats it as data and names no one.
- Work on a branch in a worktree and open a PR; Codex reviews every PR. Read its findings and
  fix or answer each one.
- Node 24, TypeScript run directly by tsx and Node's type stripping, no build step yet.
