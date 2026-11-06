// Bundles each app into a single self-contained ESM file and assembles the plugin payload.
// Output layout (dist/) mirrors what `jerry install` copies into JERRY_HOME:
//   dist/plugin/   Claude Code plugin (manifest, hooks.json, bundled bridge)
//   dist/core/     JERRY Core service
//   dist/cli/      jerry CLI
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'claude-plugin'), path.join(dist, 'plugin'), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'apps/hook-bridge/src/main.ts')], outfile: path.join(dist, 'plugin/hooks/bridge.mjs'), minify: true }),
  build({ ...common, entryPoints: [path.join(root, 'apps/core/src/main.ts')], outfile: path.join(dist, 'core/core.mjs') }),
  build({ ...common, entryPoints: [path.join(root, 'apps/cli/src/main.ts')], outfile: path.join(dist, 'cli/jerry.mjs'), banner: { js: '#!/usr/bin/env node' } }),
]);

for (const file of ['plugin/hooks/bridge.mjs', 'core/core.mjs', 'cli/jerry.mjs']) {
  const size = fs.statSync(path.join(dist, file)).size;
  console.log(`dist/${file}  ${(size / 1024).toFixed(1)} KiB`);
}
