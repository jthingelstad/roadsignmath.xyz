/** Uploads the code zip the build packaged (tools/package-native.ts) to the code bucket, which the
 * hand-applied deploy stack owns (infra/deploy.yaml), as native/app/<sha256>.zip, and returns the
 * template parameter that names it (AppCode). A key is written once (If-None-Match) and never
 * changed, so a revert finds its code still there. The zip is hashed again first, so a bundle
 * changed after the build is refused. Reads metadata only; never a secret value. */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Manifest } from './package-native.ts';
import { deployStackName, region, releaseIdentity, stackInAccount } from './release-identity.ts';

type Artifact = Manifest['artifacts'][number];
export const keyFor = (artifact: Pick<Artifact, 'name' | 'sha256'>) => `native/${artifact.name}/${artifact.sha256}.zip`;

export async function readManifest(directory: string): Promise<Artifact[]> {
  if (!isAbsolute(directory)) throw new Error('An absolute artifact directory is required');
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as Manifest;
  const artifacts = manifest.artifacts ?? [];
  if (
    manifest.schema !== 1 ||
    artifacts.length !== 1 ||
    artifacts[0]!.name !== 'app' ||
    artifacts[0]!.file !== 'app.zip' ||
    !/^[a-f0-9]{64}$/.test(artifacts[0]!.sha256)
  )
    throw new Error('Invalid artifact manifest');
  return artifacts;
}

/** The code bucket, from the deploy stack in the caller's own account. */
export async function codeBucket(account: string, cloudFormation = new CloudFormationClient({ region })) {
  const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: deployStackName }))).Stacks?.[0];
  const bucket = stack?.Outputs?.find((o) => o.OutputKey === 'CodeBucketName')?.OutputValue;
  if (!bucket || !stackInAccount(stack?.StackId, deployStackName, account)) throw new Error('Missing code bucket');
  return bucket;
}

export async function uploadArtifacts(directory: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A source commit is required');
  const artifacts = await readManifest(directory);
  for (const artifact of artifacts) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(directory, artifact.file))) hash.update(bytes);
    const digest = hash.digest();
    if (
      digest.toString('hex') !== artifact.sha256 ||
      digest.toString('base64') !== artifact.codeSha256 ||
      (await stat(resolve(directory, artifact.file))).size !== artifact.size
    )
      throw new Error('Artifact differs from its build manifest');
  }
  const { account } = await releaseIdentity();
  const bucket = await codeBucket(account);
  const s3 = new S3Client({ region });
  const parameters: Record<string, string> = {};
  for (const artifact of artifacts) {
    const key = keyFor(artifact);
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (head.Metadata?.sha256 !== artifact.sha256 || head.ContentLength !== artifact.size)
        throw new Error('Existing artifact does not match');
    } catch (error) {
      if (!(error instanceof Error) || !['NotFound', 'NoSuchKey'].includes(error.name)) throw error;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(resolve(directory, artifact.file)),
          ContentLength: artifact.size,
          ContentType: 'application/zip',
          ChecksumSHA256: artifact.codeSha256,
          IfNoneMatch: '*',
          Metadata: { sha256: artifact.sha256, commit },
          ServerSideEncryption: 'AES256'
        })
      );
      const checked = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (checked.Metadata?.sha256 !== artifact.sha256 || checked.ContentLength !== artifact.size)
        throw new Error('Artifact upload was not confirmed');
    }
    parameters.AppCode = artifact.sha256;
  }
  return { parameters };
}
