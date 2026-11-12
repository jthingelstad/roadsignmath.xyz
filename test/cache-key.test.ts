// The edge's cache key holds only the query parameters the server reads (infra/template.yaml), so
// a crawler's made-up query is a hit instead of a miss that reaches the function. A parameter a
// route reads that the key leaves out never reaches the server at all (the origin gets only the
// key's), so this finds every one the code reads and fails when the template misses it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { COOKIE, MARKER_COOKIE, SESSION_COOKIE } from '../src/quiz/session.ts';
import { ACCOUNT_PATHS } from '../src/web/account.tsx';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** CloudFormation's short tags, read as plain values: only the policies' literals matter here. */
const CFN = yaml.DEFAULT_SCHEMA.extend(
  ['Ref', 'Sub', 'GetAtt', 'If', 'Not', 'Equals', 'ImportValue', 'Select', 'Join', 'Split', 'FindInMap'].flatMap(
    (tag) =>
      (['scalar', 'sequence', 'mapping'] as const).map(
        (kind) => new yaml.Type(`!${tag}`, { kind, construct: (data: unknown) => ({ [tag]: data }) })
      )
  )
);

// oxlint-disable-next-line no-explicit-any -- the template is read loosely
type Resource = { Type: string; Properties: Record<string, any> };
const template = yaml.load(readFileSync(join(ROOT, 'infra/template.yaml'), 'utf8'), { schema: CFN }) as {
  Resources: Record<string, Resource>;
};
const resources = template.Resources;

/** CloudFront's quota: query strings per cache policy (Service Quotas, CloudFront; 10 by default). */
const PER_POLICY = 10;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every query parameter the server's code reads, by file: `c.req.query('x')`, `c.req.queries('x')`,
 * `searchParams.get('x')`, and a helper's literal when the helper reads its argument
 * (`numberParam(c, 'lat', ...)`). A read this can't name fails, so a new way of reading the query
 * has to be taught here.
 */
function reads(): { file: string; name: string }[] {
  const found: { file: string; name: string }[] = [];
  for (const path of files(SRC)) {
    const file = relative(SRC, path);
    // Quiz has its own distribution, which forwards every query string.
    if (file.startsWith('quiz/')) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/(?:req\.quer(?:y|ies)|searchParams\.get)\(\s*(['"`])([^'"`]*)\1\s*\)/g)) {
      found.push({ file, name: m[2]! });
    }
    for (const m of text.matchAll(/req\.quer(?:y|ies)\(\s*([^'"`\s)][^)]*)?\)/g)) {
      const arg = m[1]?.trim();
      assert.ok(arg, `${file}: reads the whole query; name the parameters instead`);
      // A helper reading the parameter it is given: find it, then every literal it is called with.
      const before = text.slice(0, m.index);
      const helper = [...before.matchAll(/function (\w+)\(\s*c: Context,\s*(\w+): string/g)].at(-1);
      assert.ok(helper && helper[2] === arg, `${file}: reads the query by a name this test can't follow (${m[0]})`);
      const calls = [...text.matchAll(new RegExp(`\\b${helper[1]}\\(\\s*c,\\s*(['"])(\\w+)\\1`, 'g'))];
      assert.ok(calls.length > 0, `${file}: ${helper[1]} is never called with a name`);
      for (const call of calls) found.push({ file, name: call[2]! });
    }
  }
  return found;
}

const queryStrings = (policy: string): { behavior: string; names: string[] } => {
  const config = resources[policy]!.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin
    .QueryStringsConfig as { QueryStringBehavior: string; QueryStrings?: string[] };
  return { behavior: config.QueryStringBehavior, names: config.QueryStrings ?? [] };
};

const distribution = (name: string) => resources[name]!.Properties.DistributionConfig;
const policyOf = (behavior: { CachePolicyId: unknown }): string => (behavior.CachePolicyId as { Ref: string }).Ref;

test('the site’s cache keys hold every query parameter a route reads, and no other', () => {
  const site = distribution('Distribution');
  const pagesPolicy = policyOf(site.DefaultCacheBehavior);
  const api = site.CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === '/api/*');
  const apiPolicy = policyOf(api);
  assert.notEqual(pagesPolicy, apiPolicy);

  const pages = queryStrings(pagesPolicy);
  const apis = queryStrings(apiPolicy);
  for (const p of [pages, apis]) {
    assert.equal(p.behavior, 'whitelist');
    assert.ok(p.names.length <= PER_POLICY, `CloudFront takes at most ${PER_POLICY} query strings a policy`);
  }

  // The website's code is under src/web; everything else the site front runs is the API's.
  const found = reads();
  const want = (web: boolean) =>
    [...new Set(found.filter((r) => r.file.startsWith('web/') === web).map((r) => r.name))].sort();
  for (const name of ['sort', 'year', 'state', 'at', 'view']) assert.ok(want(true).includes(name), name);
  for (const name of ['lat', 'lng', 'numbers', 'cursor', 'limit']) assert.ok(want(false).includes(name), name);

  for (const r of found) {
    const key = r.file.startsWith('web/') ? pages : apis;
    assert.ok(
      key.names.includes(r.name),
      `src/${r.file} reads ?${r.name}: add it to ${r.file.startsWith('web/') ? pagesPolicy : apiPolicy}`
    );
  }
  assert.deepEqual([...pages.names].sort(), want(true), `${pagesPolicy} keys a parameter no page reads`);
  assert.deepEqual([...apis.names].sort(), want(false), `${apiPolicy} keys a parameter the API doesn't read`);

  // The origin gets the key's parameters and nothing else, so what is cached is what was asked.
  const request = resources.WebRequestPolicy!.Properties.OriginRequestPolicyConfig;
  assert.equal(request.QueryStringsConfig.QueryStringBehavior, 'none');
  for (const b of [site.DefaultCacheBehavior, api]) assert.equal(b.OriginRequestPolicyId.Ref, 'WebRequestPolicy');
});

test('Quiz keeps forwarding every query string and its cookie, caches nothing and is compressed', () => {
  const quiz = distribution('QuizDistribution').DefaultCacheBehavior;
  assert.equal(quiz.Compress, true);
  const policy = resources[policyOf(quiz)]!.Properties.CachePolicyConfig;
  const key = policy.ParametersInCacheKeyAndForwardedToOrigin;
  // CloudFront compresses only under a policy that can cache, so not managed CachingDisabled;
  // MinTTL 0 lets every Quiz page's no-store stand, and MaxTTL caps what forgets it at a second.
  assert.equal(policy.MinTTL, 0);
  assert.equal(policy.DefaultTTL, 0);
  assert.equal(policy.MaxTTL, 1);
  assert.equal(key.EnableAcceptEncodingGzip, true);
  assert.equal(key.EnableAcceptEncodingBrotli, true);
  assert.equal(key.QueryStringsConfig.QueryStringBehavior, 'all');
  assert.deepEqual(key.CookiesConfig, { CookieBehavior: 'whitelist', Cookies: [COOKIE, SESSION_COOKIE] });
  const request = resources[quiz.OriginRequestPolicyId.Ref]!.Properties.OriginRequestPolicyConfig;
  assert.equal(request.QueryStringsConfig.QueryStringBehavior, 'all');
});

test('the site’s signed-in paths are never cached, take every method and alone get the sign-in cookie', () => {
  const site = distribution('Distribution');
  const signedIn = site.CacheBehaviors.filter((b: { PathPattern: string }) =>
    (ACCOUNT_PATHS as readonly string[]).includes(b.PathPattern)
  );
  // Every path the signed-in side answers under has its behaviour, and no other path is the server's.
  assert.deepEqual(signedIn.map((b: { PathPattern: string }) => b.PathPattern).sort(), [...ACCOUNT_PATHS].sort());
  for (const path of site.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern)) {
    assert.ok(['/api/*', '/p/*', ...ACCOUNT_PATHS].includes(path), `${path} is a behaviour this test doesn't know`);
  }
  for (const b of signedIn) {
    assert.equal(b.TargetOriginId, 'web');
    assert.equal(b.Compress, true);
    assert.deepEqual(b.AllowedMethods, ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
    assert.equal(b.ResponseHeadersPolicyId, site.DefaultCacheBehavior.ResponseHeadersPolicyId);
    assert.deepEqual(b.FunctionAssociations, site.DefaultCacheBehavior.FunctionAssociations);
    const policy = resources[policyOf(b)]!.Properties.CachePolicyConfig;
    assert.equal(policy.DefaultTTL, 0);
    assert.ok(policy.MaxTTL <= 1, `${b.PathPattern} can be cached`);
    const key = policy.ParametersInCacheKeyAndForwardedToOrigin;
    assert.ok(key.CookiesConfig.Cookies.includes(SESSION_COOKIE), `${b.PathPattern} doesn't get the sign-in cookie`);
    assert.equal(key.QueryStringsConfig.QueryStringBehavior, 'all');
    const request = resources[b.OriginRequestPolicyId.Ref]!.Properties.OriginRequestPolicyConfig;
    assert.ok(request.HeadersConfig.Headers.includes('Origin'), 'a POST’s Origin is checked');
  }
  // Every other site path, pages and API, gets no cookie at all: the same answer for everyone.
  for (const b of [site.DefaultCacheBehavior, ...site.CacheBehaviors.filter((x: unknown) => !signedIn.includes(x))]) {
    const key = resources[policyOf(b)]?.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin;
    if (key) assert.deepEqual(key.CookiesConfig, { CookieBehavior: 'none' }, `${b.PathPattern ?? 'default'}`);
    if (b.OriginRequestPolicyId) {
      const request = resources[b.OriginRequestPolicyId.Ref]!.Properties.OriginRequestPolicyConfig;
      assert.equal(request.CookiesConfig.CookieBehavior, 'none');
    }
  }
  // The marker the header reads holds no secret and is read by the browser only: never forwarded.
  for (const r of Object.values(resources)) {
    const cookies = r.Properties?.CachePolicyConfig?.ParametersInCacheKeyAndForwardedToOrigin?.CookiesConfig?.Cookies;
    assert.ok(!cookies?.includes(MARKER_COOKIE));
  }
});
