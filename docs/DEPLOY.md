# Deploying roadsignmath.xyz

How the server is hosted, how a release works, and the first deploy step by step. Hosting, the
domain move and every deploy are the owner's call; nothing here runs without the owner's go.

## What runs where

One AWS stack, `roadsignmath-xyz` ([`infra/template.yaml`](../infra/template.yaml)), in
us-east-1:

- **The web function** (`roadsignmath-xyz-web`): a Lambda Web Function running
  [`src/server.ts`](../src/server.ts), Node 24 on Arm64, behind its private `live` endpoint.
  Its revision's description is the commit it was built from.
- **CloudFront** in front, for `roadsignmath.xyz` and `www.roadsignmath.xyz` (which redirects
  to the apex). `/api/*` and everything else go to the function, signed with an origin access
  control, so nothing reaches the function except through CloudFront. The website's pages are
  kept at the edge for a day (Popular six hours) and cleared whenever one changes: the function
  clears the distribution after a request that writes a sign, a way or a player (at most once a
  minute, with a trailing clear for a write inside that minute), and each release clears it
  ([`src/edge-cache.ts`](../src/edge-cache.ts)). The API's public reads are kept a minute. The
  cache key holds only the query parameters the pages and the API read; Quiz keeps nothing but is
  compressed at the edge. `/p/*` is the shown photos, from the photo bucket, cached for a year.
- **The table** (`roadsignmath-xyz`): one DynamoDB table, on demand, with point-in-time
  recovery, deletion protection and a TTL on `expiresAt`. A stack delete keeps it.
- **The photo bucket**: versioned and private. CloudFront reads `p/` only. Uploads nobody posted
  go after a day, and replaced or deleted photos 30 days after.
- **Sign-in mail** from `signin@roadsignmath.xyz` through SES, DKIM-signed, with
  `bounce.roadsignmath.xyz` as the MAIL FROM domain. The function may send only as that address.
- **The runtime secret**, `roadsignmath-xyz-runtime` in Secrets Manager, with three keys:
  `ANTHROPIC_API_KEY` (the moderator's), `TINYLYTICS_API_KEY` (a full-access Tinylytics key,
  for hearts and the app's screen views) and `BUTTONDOWN_API_KEY` (the players' newsletter, from
  the 1Password item "Buttondown - Road Sign Math"; without it new players aren't added or
  tagged and deleted ones aren't removed). The owner keeps that secret by hand; no stack or deploy
  writes it, and the function may read it and no other. Without the first, posting and reporting
  answer 503 and change nothing; without the second, every sign's `hearts` is null, hearting
  answers 503, and app views are dropped. Everything else works either way. The function reads
  the Tinylytics key again within an hour of a change (five minutes while it is missing).
- **Logs and the alarm topic**: the function's log (90 days), the distribution's access log in
  `/roadsignmath-xyz/web-access` (24 months, no client IP or query), and a count-only
  metric of the hourly sign-in limit (`RoadSignMath/SignInTotalLimited`). The stack has no
  alarms since 2026-11-03: the account keeps a few, only where someone acts on them, and the
  four this stack had (server errors, the endpoint's two ceilings, the sign-in limit) were
  removed. The `roadsignmath-xyz-alarms` topic, which feeds the `projects-ops-alerts` queue,
  stays for any alarm added later.

Two small stacks beside it, applied by hand and never from a workflow:

- `roadsignmath-xyz-deploy` ([`infra/deploy.yaml`](../infra/deploy.yaml)): the GitHub deploy
  role (`RoadSignMathGitHubDeploy`), the CloudFormation service role every release runs as
  (`RoadSignMathCloudFormation`), and the code bucket the code zips go to. The service role can
  read the account's shared `edge` web ACL, which the distribution uses (projects-sysadmin's
  `edge-waf` stack, since 2026-11-02; its rules count and none blocks yet): CloudFront reads it
  as the caller on every update of the distribution.
- `roadsignmath-xyz-backup` ([`infra/backup.yaml`](../infra/backup.yaml)): a monthly AWS Backup
  copy of the table and the photo bucket, each deleted 330 days after it is made, so anything
  deleted is gone from the backups within a year, as `/privacy` says (Jamie, 2026-11-10): a
  photo copy keeps the bucket's old versions, which stay 30 days after a delete. Applied
  by hand, never on merge. A lifecycle change reaches only copies made after it; an older copy
  keeps its own until `aws backup update-recovery-point-lifecycle` changes it.

The `roadsignmath.xyz` zone itself is projects-sysadmin's `dns-roadsignmath-xyz` stack. This
stack writes only its certificate's validation records there; the apex, `www`, `quiz`, DKIM and
MAIL FROM records are the zone stack's, and this stack prints them as outputs (`QuizRecords` is
Quiz's distribution, added 2026-11-11).

## A release

Once releases are on (step 6 below), a merge to main releases it. `deploy` ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml))
follows each green `validate` run on main:

1. **gate**: only a push to main in this repository, or main's tip run by hand once its own
   `validate` passed.
2. **build**, with no credentials: [`scripts/build-release.sh`](../scripts/build-release.sh)
   installs the locked packages without their install scripts, runs `npm run verify`, bundles
   the server and the release tool with esbuild, adds Sharp's Linux Arm64 runtime and packages
   one deterministic zip, named by its SHA-256.
3. **deploy**, in the `production` environment as `RoadSignMathGitHubDeploy`:
   [`scripts/release.sh`](../scripts/release.sh) uploads the zip to
   `native/app/<sha256>.zip` (written once, never changed), runs one stack update through the
   service role (a new revision of this build, and `live` moved to it), confirms the endpoint's
   CloudFront grant ([`tools/web-platform.ts`](../tools/web-platform.ts)), clears the
   distribution's cache (`/*`; a warning, not a failure, until the deploy stack grants the role
   `cloudfront:CreateInvalidation`) and probes the
   release ([`tools/release-probe.ts`](../tools/release-probe.ts)): `live` serves an active
   revision of this commit, and `GET /api/v1` answers through the distribution's own
   `cloudfront.net` name. The probe reads nothing of any player's.

A failed stack update rolls back whole, and nothing anyone is served changes. A failed probe
turns the run red but leaves the release serving. **Roll back by reverting the merge**, through
a pull request like any other change; its release puts the earlier code back the same way.
`./deploy.sh` runs the same build and release from the Mac (it is how the first release goes
out, and `--break-glass` is for GitHub being down).

The repository and its Actions logs are public. No account id, ARN or resource id is written in
the repository: the deploy role's ARN is an environment secret, the scripts read every
identifier from the stacks, and in Actions they mask each one before using it.

## The first deploy

In order. Each step that needs the owner's go says so; the approval lines are written to be sent
back as they are.

1. **Apply the deploy stack** (IAM, so the owner's go):
   `Approved: apply infra/deploy.yaml as the roadsignmath-xyz-deploy stack, which creates the RoadSignMathGitHubDeploy and RoadSignMathCloudFormation roles and the code bucket`

   ```sh
   aws cloudformation deploy --profile cloud-engineer --region us-east-1 \
     --stack-name roadsignmath-xyz-deploy --template-file infra/deploy.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags Application=RoadSignMath Project=roadsignmath.xyz ManagedBy=cloudformation
   ```

2. **The GitHub environment** (the owner, in the repository's settings): an environment named
   `production` that admits only `main`, with no reviewers, and an environment secret
   `RELEASE_DEPLOY_ROLE_ARN` set to the deploy stack's `DeployRoleArn` output.
3. **The runtime secret** (the owner, in the Secrets Manager console, us-east-1): a secret named
   `roadsignmath-xyz-runtime`, of type "Other", with two key/value pairs: `ANTHROPIC_API_KEY` and
   the moderator's key, and `TINYLYTICS_API_KEY` and a full-access (`tly-fa-`) Tinylytics key.
   A third, `BUTTONDOWN_API_KEY`, holds the newsletter's Buttondown key (added 2026-11-07).
   No agent reads or writes their values. They can come after the first release; until then
   posting answers 503 and hearts are off.
4. **The alerts queue** (an account change outside a deploy, so the owner's go): add
   `arn:aws:sns:us-east-1:<account>:roadsignmath-xyz-alarms` to the `aws:SourceArn` list in the
   `projects-ops-alerts` queue policy, and to its table in projects-sysadmin's
   `docs/OPERATIONS.md`. Until then the alarms fire but their messages are dropped.
   `Approved: add the roadsignmath-xyz-alarms topic to the projects-ops-alerts queue policy`
5. **The first release** (the owner's go): `./deploy.sh` from a clean, green main on the Mac.
   It creates the stack (the certificate waits for its DNS validation, usually a few minutes,
   and the distribution takes up to about fifteen more), runs a second update so the function
   knows its own distribution, then installs the endpoint grant and probes through
   `cloudfront.net`. roadsignmath.xyz still serves the micro.blog: nothing points at the
   distribution yet.
   `Approved: run the first roadsignmath-xyz release with deploy.sh`
6. **Releases on merge** (the owner, in the repository's settings): set the repository variable
   `RELEASES` to `on`. Until it is, `deploy` skips every run, so merges before the first release
   change nothing in AWS.
7. **Mail records** (the owner's line, as for every mail record): a projects-sysadmin PR adding the
   stack's `DkimRecords` (three CNAMEs) and `MailFromRecords` (an MX and an SPF TXT on
   `bounce.roadsignmath.xyz`) to `config/dns-roadsignmath-xyz-stack.yaml`. The apex SPF
   (`include:amazonses.com`) and DMARC are already there. SES verifies the domain once the DKIM
   records resolve; until then sign-in mail does not go. (The account already has SES production
   access, so no sandbox request.)
   `Approved: add the roadsignmath-xyz SES DKIM and MAIL FROM records to the dns-roadsignmath-xyz stack`
8. **The domain move** (the owner's call; it takes the micro.blog down): in the same zone stack,
   replace the apex A and AAAA and the `www` CNAME with alias A and AAAA records to the
   distribution (`SiteRecords` output).
   `Approved: point roadsignmath.xyz and www at the roadsignmath-xyz distribution`
9. **Backups**, once the stack exists:

   ```sh
   aws cloudformation deploy --profile cloud-engineer --region us-east-1 \
     --stack-name roadsignmath-xyz-backup --template-file infra/backup.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags Application=RoadSignMath Project=roadsignmath.xyz ManagedBy=cloudformation
   ```

   `Approved: apply infra/backup.yaml as the roadsignmath-xyz-backup stack, which creates the RoadSignMathBackup role`
10. **The launch signs** (a separate go): seeding the 16 micro.blog signs into the live table
    and photo bucket is a write to live data, done once, on its own approval.
11. **Branch protection**: a ruleset on `main` requiring the `validate` check, so only a green
    pull request merges and every merge releases.

After the first release, every merge to main releases itself.

## The app's links (apple-app-site-association)

The site serves `/.well-known/apple-app-site-association` (and the same file at the root) so the
sign-in link in the email and a sign's page open the iPhone app ([`src/web/apple.ts`](../src/web/apple.ts)).
It names the app by the Apple Team ID that signs it, which the stack holds as `AppleTeamId`
rather than the repository. Set it, or change it, with one release from the Mac:

```sh
APPLE_TEAM_ID=<team id> ./deploy.sh
```

The team id is the app's `DEVELOPMENT_TEAM`, and the `OU` in the subject of the Mac's signing
certificate (`security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`).
It is not the id in parentheses after the name on that certificate: that one is the person's,
and an association file naming it opens nothing. Every later release, GitHub's included, keeps
the stack's value. While it is empty the site serves no association file and the links open in
Safari, where `/signin` says to use the link on the iPhone or type the code.

## Checking a release by hand

Reads only: the `deploy` run's log, the stack's events, and `GET /api/v1` through
the site. Never post, sign in or report as a real player to check a release.

First-release things worth a look, from the Release Notes platform notes: the endpoint is
`IamAuth` and only CloudFront's signed requests reach it; CloudFront's `always-amz-auth` signing
leaves a player's `Authorization` header as sent (shown there for GET, HEAD and POST; this API's
PATCH and DELETE routes are the first to use the other methods through it).

## When a report comes in

Each report of a sign, and each "Report a duplicate", is emailed to `FEEDBACK_TO`, where Send
feedback goes (`src/reports.ts`): the sign's title and link, the reason or note, Claude's verdict
(hidden or kept) and the reporter's name and handle, never an email address. The email names the
owner commands below for that sign. There is no admin website; Jamie acts from the Mac with
`npm run owner` ([`tools/owner.ts`](../tools/owner.ts), the logic in `src/owner.ts`):

```sh
npm run owner -- hide-sign <slug> --to check            # read only: what would change
npm run owner -- hide-sign <slug> --to live [--note "…"]
npm run owner -- unhide-sign <slug> --to check|live
npm run owner -- set-place <slug> --lat=<n> --lng=<n> [--label "…"] [--state XX] [--approximate] --to check|live
npm run owner -- remove-way <slug> --to check            # read only: the sign's ways and their ids
npm run owner -- remove-way <slug> --way <id> --to check|live
npm run owner -- remove-player <handle> --to check
TINYLYTICS_API_KEY=… BUTTONDOWN_API_KEY=… npm run owner -- remove-player <handle> --to live
npm run owner -- merge-signs <keep> <drop> [--photos drop:1,keep:1] [--found-on drop|keep] \
  [--posted-at drop|keep] [--place drop|keep] [--caption keep|drop|both] \
  [--caption-trim "<exact last sentence>"] --to check   # read only: what merging would change
TINYLYTICS_API_KEY=… npm run owner -- merge-signs <keep> <drop> … --to live
npm run owner -- set-alt --file <alts.json> [--force] --to check|live
```

- `hide-sign` leaves the sign as an upheld report does (`hideSign`): its photos leave `p/` and
  CloudFront, the sign is `hidden`, gone from the site, feeds, open data and API for everyone but
  its poster, who sees the note (by default "Jamie took this sign down under the house rules.").
  `unhide-sign` shows a hidden or held sign again. Both hold the sign's report lease, so they
  never cross a player's report.
- `set-place` puts a sign on the map: the coordinates, and the label and two-letter state when
  given (left out, they stay; `--state ""` clears it). The pin counts as exact unless
  `--approximate`. Write a negative number with `=` (`--lng=-87.26`). It holds the report lease too.
- `remove-way` takes one way off a sign (Jamie, 2026-11-12, for a way that left a number out):
  the way, the co-finds on it, and the sign's way count and first way kept in step, as an account
  delete does for its ways. It holds the report lease too.
- `remove-player` is `DELETE /me` for that player (`removePlayer`, the same code): the account
  and everything it made, their hearts' kudos first, then their address leaves the newsletter.
  `--to live` needs the Tinylytics and Buttondown keys through the environment (`op run`), never
  on the command line, and refuses without them.
- `merge-signs` makes one sign of a road sign posted twice (Jamie, 2026-11-12: "Merge the two
  genesis signs into a single sign with two photos."). The kept sign keeps its id, slug, title,
  numbers, hearts and address, so its feed item, share card and old links stay. Each of
  `--found-on`, `--posted-at` and `--place` takes the dropped sign's value with `drop` and keeps
  the kept sign's by default; `--caption` is the kept caption (default), the dropped one, or
  `both` (kept, a blank line, dropped), and `--caption-trim` takes one exact sentence off its end
  (refused when it isn't there). `--photos drop:1,keep:1,keep:2` lists the photos the sign ends
  with, at most four (1 is each sign's first); left out, it is the kept sign's then the dropped
  sign's. A photo left out is deleted; a dropped sign's photo that stays keeps its id, files and
  alt text, since only the kept sign's row points at it. The dropped sign's ways move over with
  their co-finds unless the kept sign has the same way (`sameWayKey`), whose author and co-finders
  are credited there instead; the count and first way follow the ways, oldest first. Finders are
  both signs' with no one twice. A player who hearted only the dropped sign has the heart moved;
  one who hearted both keeps the kept sign's; the website's anonymous kudos on the dropped sign
  are taken back, as a delete takes them. Reports and duplicate reports go with the dropped sign.
  Its slug's row then points at the kept sign, so `/signs/<drop>` on the site and in Quiz, and
  `/api/v1/signs/<drop>`, answer a 301 to the kept sign (`mergedSlugs` in `src/web/permalinks.ts`),
  and a seed never makes it again. The API answers its own request first (a bad token is still a
  401) and turns only its 404 into the 301. A micro.blog post or photo address of the dropped sign
  follows the merge record too (`old-links.ts`), and a sign merged into the dropped one before comes
  along, its slug leading to the kept sign. `--to check` shows the heart rows and kudos on the dropped sign
  (the public count without the key). `--to live` needs the Tinylytics key through the environment
  only when hearts or kudos move, and refuses before any write without it. It holds both signs'
  report leases. A run that fails partway is finished by running it again; once it is done,
  `check` says there is nothing to do.
- `set-alt` sets photo alt text from a JSON list of `{ "sign_id", "photo_id", "alt" }` (other
  fields are ignored; Jamie, 2026-11-12, for alt text written after looking at each photo).
  `check` prints each photo's slug, old alt and new alt. The whole file is refused, naming each
  entry, if a sign or photo isn't there or an alt is empty, over 300 characters or has a line
  break. Only a generic "Photo of the … sign" or empty alt is replaced unless `--force`; others
  are skipped with a note. `live` writes each changed sign's photos alone (`updateSign`).
- `--to check` only reads the live table. `--to live` is a write to live data, the owner's alone,
  and clears the edge once at the end, even when it fails partway. It reads the table, photo bucket and distribution from the
  `roadsignmath-xyz` stack as `cloud-engineer`. It never prints an email address.

### The newsletter's list and tags

`npm run newsletter` ([`tools/newsletter-sync.ts`](../tools/newsletter-sync.ts)) puts every player
with an address on the Buttondown list, with their tags: `first-era` for the archive's 2005-2014
players, and `app` or `quiz` for each place they have a live session (a session from before
12 November 2026 records none and was the app's). The server adds and tags players at sign-in; the
tool is for the players from before, and was run to tag the list once on Jamie's go (2026-11-12).

```sh
op run --env-file=<file naming BUTTONDOWN_API_KEY> -- npm run newsletter -- --to check   # reads only
op run --env-file=<file naming BUTTONDOWN_API_KEY> -- npm run newsletter -- --to live    # the owner's go
```

It reads the live table as `cloud-engineer` and writes only the short lease each tag change is
made under, the server's too, so a sign-in at the same moment can't undo it. It prints counts only,
never an address. Tags are only added, never taken off, and nobody is resubscribed. If Buttondown
refuses a tag (tags need its Basic plan or higher), it stops at the first refusal.
