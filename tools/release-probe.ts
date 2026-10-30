/** What a release checks once its stack update is done: the live endpoint serves an active
 * revision of this build, and the API answers its index through CloudFront. The index is a
 * read-only GET (`GET /api/v1`, the version and the counts), asked of the distribution's own
 * cloudfront.net name, so the probe works before and after roadsignmath.xyz points at it. Nothing
 * here reads or writes a player's data. A failure leaves the release serving: the fix is a
 * revert, released like any other merge. */
import { GetWebFunctionRevisionCommand } from '@aws-sdk/client-lambda-web';
import { context, liveEndpoint, required, type Context } from './web-platform.ts';

export type ProbeDeps = {
  ctx: Context;
  fetch: (url: string) => Promise<Pick<Response, 'status' | 'json'>>;
  pause: (ms: number) => Promise<void>;
};

async function endpoint(deps: ProbeDeps, commit: string) {
  const { ctx } = deps;
  const { functionName, revision } = await liveEndpoint(ctx);
  if (revision !== required(ctx.outputs, 'WebLiveRevisionId'))
    throw new Error('live is not the revision this release built');
  const answer = await ctx.web.send(new GetWebFunctionRevisionCommand({ functionName, revisionId: revision }));
  if (answer.state !== 'Active' || answer.description !== commit)
    throw new Error('the live revision is not an active one of this build');
}

async function index(deps: ProbeDeps) {
  const domain = required(deps.ctx.outputs, 'DistributionDomain');
  if (!/^[a-z0-9]+\.cloudfront\.net$/.test(domain)) throw new Error('Unexpected distribution domain');
  // A query no one else sends, so the answer is this release's and not one CloudFront kept.
  const url = `https://${domain}/api/v1?probe=${Date.now()}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await deps.fetch(url);
      if (response.status === 200) {
        const body = (await response.json()) as { api_version?: unknown };
        if (typeof body.api_version === 'string') return;
      }
    } catch {
      // A network error is retried like any other failed answer.
    }
    if (attempt === 5) throw new Error('The API index did not answer through CloudFront');
    await deps.pause(3000);
  }
}

export async function probe(commit: string, given: Partial<ProbeDeps> = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A committed build is required');
  const deps: ProbeDeps = {
    ctx: given.ctx ?? (await context()),
    fetch: given.fetch ?? ((url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })),
    pause: given.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
  await endpoint(deps, commit);
  await index(deps);
  return { endpoint: 'live', index: 'ok' };
}
