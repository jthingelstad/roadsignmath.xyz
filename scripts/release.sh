#!/usr/bin/env bash
# The release, shared by deploy.sh on the Mac and GitHub Actions (.github/workflows/deploy.yml).
# It deploys a bundle scripts/build-release.sh made from a commit on main; the caller has already
# checked that the commit is main and green. One run releases everything:
#
#   1. upload the code zip, named by its SHA-256 (tools/native-artifacts.ts)
#   2. one stack update: a new revision of the web function built from that zip, and `live`
#      moved to it (on the first release, the whole stack)
#   3. the endpoint's CloudFront grant (tools/web-platform.ts)
#   4. the probe (tools/release-probe.ts): `live` serves an active revision of this build and the
#      API index answers through CloudFront
#
# A failed stack update rolls itself back and nothing anyone is served changed. A failed probe
# leaves the release serving: roll back by reverting the merge, which releases the previous code
# the same way. The repository is public, so this names no account: the account is the caller's
# own, and in GitHub Actions every cloud identifier is masked in the log.
#
#   scripts/release.sh --bundle DIR --commit SHA
#   scripts/release.sh --check-arguments [options]   validate, then stop
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=roadsignmath-xyz
DEPLOY_STACK=roadsignmath-xyz-deploy
ZONE_STACK=dns-roadsignmath-xyz
REPO=$(cd "$(dirname "$0")/.." && pwd)
ACTIONS=""
[[ "${GITHUB_ACTIONS:-}" == true ]] && ACTIONS=1
refuse() { echo "refusing: $*" >&2; exit 1; }
usage() { echo "usage: $0 --bundle DIR --commit SHA" >&2; exit 2; }

BUNDLE="" COMMIT="" CHECK_ONLY="" BREAK_GLASS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) [[ $# -ge 2 ]] || usage; BUNDLE=$2; shift ;;
    --commit) [[ $# -ge 2 ]] || usage; COMMIT=$2; shift ;;
    --check-arguments) CHECK_ONLY=1 ;;
    # deploy.sh's own flag, accepted here so it can pass its arguments through.
    --break-glass) BREAK_GLASS=1 ;;
    *) usage ;;
  esac
  shift
done
[[ -z "$ACTIONS" || -z "$BREAK_GLASS" ]] \
  || { echo "refusing: --break-glass is for deploy.sh on the Mac" >&2; exit 2; }
[[ -z "$CHECK_ONLY" ]] || exit 0

[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || usage
[[ -n "$BUNDLE" && -f "$BUNDLE/release/index.js" && -f "$BUNDLE/template.yaml" && \
   -f "$BUNDLE/artifacts/manifest.json" ]] || refuse "no complete release bundle at ${BUNDLE:-(none)}"
BUNDLE=$(cd "$BUNDLE" && pwd)
[[ "$(cat "$BUNDLE/commit")" == "$COMMIT" ]] || refuse "the bundle was built from another commit"
NODE_MAJOR=$(cat "$REPO/.node-version")
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]] \
  || refuse "node is $(node -v), want $NODE_MAJOR"

mask() { [[ -z "$ACTIONS" || -z "$1" ]] || echo "::add-mask::$1"; }
read -r ACCOUNT ARN < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || refuse "no AWS account"
mask "$ACCOUNT"
# The deploy role only in Actions; tools/release-identity.ts holds the same rule.
if [[ -n "$ACTIONS" ]]; then
  [[ "$ARN" == *:assumed-role/RoadSignMathGitHubDeploy/* || "$ARN" == *:assumed-role/ProjectsCloudEngineer/* ]] \
    || refuse "unexpected release identity"
else
  [[ "$ARN" == *:assumed-role/ProjectsCloudEngineer/* ]] || refuse "unexpected release identity"
fi
RELEASE=(node "$BUNDLE/release/index.js")

# One output of a stack in this account and region, or nothing.
stack_output() {
  local id value
  read -r id value < <(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].[StackId, Outputs[?OutputKey=='$2'].OutputValue | [0]]" --output text)
  [[ "$id" == "arn:aws:cloudformation:$AWS_REGION:$ACCOUNT:stack/$1/"* ]] || refuse "$1 is not this account's stack"
  [[ "$value" != None ]] && printf '%s' "$value"
  return 0
}
CODE_BUCKET=$(stack_output "$DEPLOY_STACK" CodeBucketName)
[[ "$CODE_BUCKET" == "$STACK-code-$ACCOUNT" ]] || refuse "the deploy stack has no code bucket; apply infra/deploy.yaml"
mask "$CODE_BUCKET"
HOSTED_ZONE=$(stack_output "$ZONE_STACK" HostedZoneId)
[[ "$HOSTED_ZONE" =~ ^Z[A-Z0-9]+$ ]] || refuse "the zone stack has no HostedZoneId output"
mask "$HOSTED_ZONE"

# The stack's own distribution, from its last release, for clearing a hidden sign's photos. None
# before the first release; that release runs a second update below to fill it in.
ERRORS=$(mktemp)
trap 'rm -f "$ERRORS"' EXIT
if ! aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' \
  --output text >/dev/null 2>"$ERRORS"; then
  grep -q 'does not exist' "$ERRORS" || refuse "the stack could not be read"
  FIRST=1
fi
PHOTO_DISTRIBUTION=""
if [[ -z "${FIRST:-}" ]]; then
  PHOTO_DISTRIBUTION=$(stack_output "$STACK" DistributionId)
  mask "$PHOTO_DISTRIBUTION"
fi

# The code parameter (AppCode=<sha256>); the tool checks the name and hash, so nothing else can
# ride along as an override.
CODE_PARAMETER=$("${RELEASE[@]}" upload --artifacts "$BUNDLE/artifacts" --commit "$COMMIT")
[[ "$CODE_PARAMETER" =~ ^AppCode=[a-f0-9]{64}$ ]] || refuse "unexpected code parameter"
echo "code uploaded"

# The stack acts through its own service role (infra/deploy.yaml), whoever deploys.
update() {
  if ! aws cloudformation deploy \
    --stack-name "$STACK" \
    --template-file "$BUNDLE/template.yaml" \
    --role-arn "arn:aws:iam::$ACCOUNT:role/RoadSignMathCloudFormation" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides "BuildId=$COMMIT" "$CODE_PARAMETER" "CodeBucket=$CODE_BUCKET" \
      "HostedZoneId=$HOSTED_ZONE" "PhotoDistributionId=$1" \
    --tags Application=RoadSignMath Project=roadsignmath.xyz ManagedBy=cloudformation \
           Environment=production Repository=jthingelstad/roadsignmath.xyz >/dev/null; then
    # Which resources failed and why, newest first; identifiers are masked in CI.
    aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 50 \
      --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[Timestamp,LogicalResourceId,ResourceStatusReason]" \
      --output text >&2 || true
    refuse "the stack update failed and rolled back; nothing was released"
  fi
}
update "$PHOTO_DISTRIBUTION"
DISTRIBUTION=$(stack_output "$STACK" DistributionId)
mask "$DISTRIBUTION"
if [[ "$DISTRIBUTION" != "$PHOTO_DISTRIBUTION" ]]; then
  update "$DISTRIBUTION"
  echo "photo invalidation pointed at the new distribution"
fi
echo "stack updated"

"${RELEASE[@]}" policies >/dev/null
echo "endpoint grant confirmed"

# Another release (the Mac's while GitHub's ran, say) may be updating the stack, or have updated
# it since ours did. Wait for the stack to settle, up to 30 minutes, then probe only if this build
# is still the one live.
tries=0
while :; do
  read -r status live < <(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].[StackStatus, Parameters[?ParameterKey=='BuildId'].ParameterValue | [0]]" --output text)
  [[ "$status" == *_IN_PROGRESS ]] || break
  (( ++tries < 120 )) || refuse "another release has been updating the stack for 30 minutes ($status)"
  sleep 15
done
[[ "$live" == "$COMMIT" ]] || refuse "the stack now runs $live, released by another run"

"${RELEASE[@]}" probe --commit "$COMMIT" >/dev/null \
  || refuse "$COMMIT is live but failed its probe; revert the merge to roll back"
echo "released $COMMIT"
