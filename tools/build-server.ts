/** Bundles the live server (dist/server) and the release tool (dist/release, which
 * scripts/release.sh runs with no npm install) from the committed tree. Sharp stays outside the
 * bundle: tools/package-native.ts adds its Linux Arm64 runtime to the code zip. */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.versions.node.split('.')[0] !== '24') throw new Error('Build requires Node 24');
for (const [source, folder] of [
  ['src/server.ts', 'dist/server'],
  ['tools/release-cli.ts', 'dist/release']
] as const) {
  await mkdir(folder, { recursive: true });
  await build({
    entryPoints: [source],
    outfile: `${folder}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    external: ['sharp'],
    legalComments: 'none',
    absWorkingDir: resolve('.'),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    }
  });
}
