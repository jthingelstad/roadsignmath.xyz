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
  control, so nothing reaches the function except through CloudFront. `/p/*` is the shown
  photos, from the photo bucket, cached for a year.
- **The table** (`roadsignmath-xyz`): one DynamoDB table, on demand, with point-in-time
  recovery, deletion protection and a TTL on `expiresAt`. A stack delete keeps it.
- **The photo bucket**: versioned and private. CloudFront reads `p/` only. Uploads nobody posted
  go after a day, and replaced or deleted photos 30 days after.
- **Sign-in mail** from `signin@roadsignmath.xyz` through SES, DKIM-signed, with
  `bounce.roadsignmath.xyz` as the MAIL FROM domain. The function may send only as that address.
- **The moderator's key**, `ANTHROPIC_API_KEY` in the Secrets Manager secret
  `roadsignmath-xyz-runtime`. The owner keeps that secret by hand; no stack or deploy writes it,
  and the function may read it and no other. Until it has a key, posting and reporting answer
  503 and change nothing; everything else works.
- **Logs and alarms**: the function's log (90 days), the distribution's access log in
  `/roadsignmath-xyz/web-access` (24 months, no client IP, path or query), and count-only alarms
  on server errors, the endpoint's ceilings and the hourly sign-in limit. They go to the
  `roadsignmath-xyz-alarms` topic, which feeds the `projects-ops-alerts` queue.

Two small stacks beside it, applied by hand and never from a workflow:

- `roadsignmath-xyz-deploy` ([`infra/deploy.yaml`](../infra/deploy.yaml)): the GitHub deploy
  role (`RoadSignMathGitHubDeploy`), the CloudFormation service role every release runs as
  (`RoadSignMathCloudFormation`), and the code bucket the code zips go to.
- `roadsignmath-xyz-backup` ([`infra/backup.yaml`](../infra/backup.yaml)): a monthly AWS Backup
  copy of the table and the photo bucket, kept until removed by hand.

The `roadsignmath.xyz` zone itself is projects-sysadmin's `dns-roadsignmath-xyz` stack. This
stack writes only its certificate's validation records there; the apex, `www`, DKIM and MAIL FROM
records are the zone stack's, and this stack prints them as outputs.

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
   CloudFront grant ([`tools/web-platform.ts`](../tools/web-platform.ts)) and probes the
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
3. **The moderator's key** (the owner, in the Secrets Manager console, us-east-1): a secret named
   `roadsignmath-xyz-runtime`, of type "Other", with one key/value pair: `ANTHROPIC_API_KEY` and
   the key. No agent reads or writes its value. It can come after the first release; until then
   posting answers 503.
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

The team id is the one in parentheses on the "Apple Development" line of
`security find-identity -v -p codesigning`. Every later release, GitHub's included, keeps the
stack's value. While it is empty the site serves no association file and the links open in
Safari, where `/signin` says to use the link on the iPhone or type the code.

## Checking a release by hand

Reads only: the `deploy` run's log, the stack's events, the alarms, and `GET /api/v1` through
the site. Never post, sign in or report as a real player to check a release.

First-release things worth a look, from the Release Notes platform notes: the endpoint is
`IamAuth` and only CloudFront's signed requests reach it; CloudFront's `always-amz-auth` signing
leaves a player's `Authorization` header as sent (shown there for GET, HEAD and POST; this API's
PATCH and DELETE routes are the first to use the other methods through it).
