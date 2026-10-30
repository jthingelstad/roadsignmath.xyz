/** The code zip, deterministic from an already built, committed tree: the bundled server as
 * index.js, a package.json that makes it ESM, and Sharp's Linux Arm64 runtime under
 * node_modules/, copied from the tree scripts/build-release.sh stages. Every entry has the same
 * date and mode, so one commit always makes the same bytes, and the zip is named by its hash. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

const stamp = new Date(1980, 0, 1, 0, 0, 0);
const entry = { mtime: stamp, forceDosTimestamp: true, mode: 0o100644 };

/** Sharp's runtime closure, for the two sizes of every uploaded photo. */
export const SHARP = [
  '@img/colour',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-linux-arm64',
  'detect-libc',
  'semver',
  'sharp'
] as const;

export async function packageBundle(
  directory: string,
  destination: string,
  nativeModules?: string,
  packages: readonly string[] = SHARP
): Promise<{ sha256: string; codeSha256: string }> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const done = pipeline(output, createWriteStream(destination));
  void done.catch(() => undefined);
  zip.on('error', (error) => output.destroy(error));
  const walk = async (root: string, folder: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Native package contains a symlink');
      if (info.isDirectory()) await walk(root, path);
      else if (info.isFile()) zip.addFile(path, `node_modules/${relative(root, path).split(sep).join('/')}`, entry);
    }
  };
  try {
    zip.addBuffer(await readFile(join(directory, 'index.js')), 'index.js', entry);
    zip.addBuffer(Buffer.from('{"type":"module"}\n'), 'package.json', entry);
    if (nativeModules) {
      for (const name of [...packages].sort()) {
        const root = join(nativeModules, name);
        const info = await lstat(root).catch(() => null);
        if (!info?.isDirectory() || info.isSymbolicLink())
          throw new Error(`Native package ${name} is missing or linked`);
        await walk(nativeModules, root);
      }
    }
    zip.end();
    await done;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error('Artifact packaging failed'));
    await done.catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(destination)) hash.update(bytes);
  const digest = hash.digest();
  return { sha256: digest.toString('hex'), codeSha256: digest.toString('base64') };
}

export type Manifest = {
  schema: 1;
  artifacts: { name: 'app'; file: 'app.zip'; sha256: string; codeSha256: string; size: number }[];
};

/** The release's one zip and a manifest of its hash, made in the build step with no cloud access,
 * for the deploy step to check and upload. */
export async function packageRelease(buildDirectory: string, nativeModules: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, 'app.zip');
  const hashes = await packageBundle(resolve(buildDirectory, 'dist/server'), path, nativeModules);
  const manifest: Manifest = {
    schema: 1,
    artifacts: [{ name: 'app', file: 'app.zip', ...hashes, size: (await lstat(path)).size }]
  };
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
