/** Who may release: the Mac's cloud-engineer role anywhere, and the GitHub deploy role
 * (infra/deploy.yaml) only inside GitHub Actions. The repo is public, so it names no account:
 * the account is the caller's own, and every stack read is checked against it. */
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const region = 'us-east-1',
  stackName = 'roadsignmath-xyz',
  deployStackName = 'roadsignmath-xyz-deploy',
  deployRoleName = 'RoadSignMathGitHubDeploy';

export function allowedCaller(arn: string | undefined, actions: boolean) {
  return (
    arn?.includes(':assumed-role/ProjectsCloudEngineer/') === true ||
    (actions && arn?.includes(`:assumed-role/${deployRoleName}/`) === true)
  );
}

/** A stack's id names its account; one in another account is refused. */
export function stackInAccount(stackId: string | undefined, name: string, account: string) {
  return stackId?.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${name}/`) === true;
}

export async function releaseIdentity(sts: Pick<STSClient, 'send'> = new STSClient({ region })) {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account || !allowedCaller(identity.Arn, process.env.GITHUB_ACTIONS === 'true'))
    throw new Error('Unexpected release identity');
  return { account: identity.Account };
}
