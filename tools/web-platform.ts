/** Sole owner of the web function's resource policy, which CloudFormation cannot hold (the
 * AWS::Lambda::ResourcePolicy schema refuses web-function ARNs). It grants CloudFront, from this
 * stack's distributions only (the site's, and Quiz's once it exists), the live endpoint only.
 * Every release installs a missing policy and checks that an existing one is exactly that grant.
 * The one rewrite is the upgrade from the site-only grant to the grant naming both distributions,
 * once Quiz's exists (2026-11-11). Nothing here removes a policy or rewrites any other: CloudFront
 * reaches the server only through it, so a policy that differs is refused for a person to look at. */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  GetResourcePolicyCommand,
  GetWebFunctionEndpointCommand,
  type GetWebFunctionEndpointResponse,
  LambdaWebClient,
  PutResourcePolicyCommand
} from '@aws-sdk/client-lambda-web';
import { region, releaseIdentity, stackInAccount, stackName } from './release-identity.ts';

export type Context = {
  account: string;
  /** The site's distribution, then Quiz's when the stack has one. */
  distributionArns: string[];
  outputs: Record<string, string>;
  web: Pick<LambdaWebClient, 'send'>;
};

/** The exact endpoint-only grant, to one distribution or several; never permits public invocation. */
export function endpointPolicy(endpointArn: string, distributionArns: string[]) {
  if (distributionArns.length === 0) throw new Error('A grant names at least one distribution');
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'RoadSignMathCloudFrontLiveOnly',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 'lambda:InvokeWebFunctionEndpoint',
        Resource: endpointArn,
        Condition: {
          StringEquals: { 'aws:SourceArn': distributionArns.length === 1 ? distributionArns[0] : distributionArns }
        }
      }
    ]
  };
}

/** JSON with sorted keys, so two policies compare by content. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Undefined policy field');
  return encoded;
}

/** The one revision a private, regional live endpoint serves. */
export function servedRevision(endpoint: GetWebFunctionEndpointResponse): string {
  const weights = endpoint.revisionWeights;
  if (
    endpoint.authType !== 'IamAuth' ||
    endpoint.endpointType !== 'HomeRegion' ||
    endpoint.autoDeploymentMode !== 'Disabled' ||
    endpoint.state !== 'Active' ||
    (endpoint.updateStatus !== undefined && endpoint.updateStatus !== 'Successful') ||
    endpoint.throttleConfig?.rateLimit !== 100 ||
    weights?.length !== 1 ||
    weights[0]?.weight !== 100 ||
    !weights[0].revisionId
  )
    throw new Error('Endpoint must be active, private, regional and serve one revision');
  return weights[0].revisionId;
}

export function required(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (!value) throw new Error(`Missing stack output ${key}`);
  return value;
}

export async function context(): Promise<Context> {
  const { account } = await releaseIdentity();
  const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName })))
    .Stacks?.[0];
  if (
    !stackInAccount(stack?.StackId, stackName, account) ||
    !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack?.StackStatus ?? '')
  )
    throw new Error('The stack must be idle after a completed update');
  const outputs = Object.fromEntries((stack!.Outputs ?? []).map((entry) => [entry.OutputKey!, entry.OutputValue!]));
  const arn = (id: string) => `arn:aws:cloudfront::${account}:distribution/${id}`;
  return {
    account,
    distributionArns: [
      arn(required(outputs, 'DistributionId')),
      ...(outputs.QuizDistributionId ? [arn(outputs.QuizDistributionId)] : [])
    ],
    outputs,
    // A write must never be blindly retried after an unknown response.
    web: new LambdaWebClient({ region, maxAttempts: 1 })
  };
}

/** The live endpoint, checked against the stack's own outputs. */
export async function liveEndpoint(ctx: Context) {
  const functionName = required(ctx.outputs, 'WebFunctionName');
  if (functionName !== `${stackName}-web`) throw new Error('Unexpected web function identity');
  const endpoint = await ctx.web.send(new GetWebFunctionEndpointCommand({ functionName, endpointName: 'live' }));
  const revision = servedRevision(endpoint);
  if (
    endpoint.functionArn !== required(ctx.outputs, 'WebFunctionArn') ||
    endpoint.endpointArn !== required(ctx.outputs, 'WebLiveEndpointArn') ||
    endpoint.domainName !== required(ctx.outputs, 'WebLiveEndpointDomain') ||
    endpoint.endpointName !== 'live'
  )
    throw new Error('Endpoint identity differs from the stack');
  return { functionName, functionArn: endpoint.functionArn, endpointArn: endpoint.endpointArn, revision };
}

async function currentPolicy(ctx: Context, functionArn: string) {
  try {
    const response = await ctx.web.send(new GetResourcePolicyCommand({ resourceArn: functionArn }));
    if (!response.policy) throw new Error('Incomplete resource policy response');
    return response.policy;
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined;
    throw error;
  }
}

/**
 * Installs the grant where there is none, confirms it where there is one, and widens the site-only
 * grant to name Quiz's distribution once it exists.
 */
export async function ensurePolicy(ctx?: Context): Promise<'installed' | 'confirmed' | 'widened'> {
  const live = ctx ?? (await context());
  const { functionArn, endpointArn } = await liveEndpoint(live);
  const desired = canonical(endpointPolicy(endpointArn, live.distributionArns));
  const siteOnly = canonical(endpointPolicy(endpointArn, live.distributionArns.slice(0, 1)));
  const actual = await currentPolicy(live, functionArn);
  let outcome: 'installed' | 'widened' = 'installed';
  if (actual !== undefined) {
    const found = canonical(JSON.parse(actual));
    if (found === desired) return 'confirmed';
    if (found !== siteOnly)
      throw new Error('The endpoint policy differs from the live-endpoint grant; look at it by hand');
    outcome = 'widened';
  }
  await live.web.send(new PutResourcePolicyCommand({ resourceArn: functionArn, policy: desired }));
  const installed = await currentPolicy(live, functionArn);
  if (installed === undefined || canonical(JSON.parse(installed)) !== desired)
    throw new Error('Policy installation was not confirmed');
  return outcome;
}
