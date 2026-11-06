// Bundles each app into a single self-contained ESM file and assembles the plugin payload.
// Output layout (dist/) mirrors what `jerry install` copies into JERRY_HOME:
//   dist/plugin/          Claude Code plugin (manifest, hooks.json, bundled bridge, MCP server)
//   dist/core/            JERRY Core service
//   dist/core/dashboard/  dashboard web app, served by Core
//   dist/cli/             jerry CLI
import vueJsx from '@vitejs/plugin-vue-jsx';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { writeIcons } from './icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'claude-plugin'), path.join(dist, 'plugin'), { recursive: true });
// The golden eval cases ship with the CLI (ADR 0036): `jerry eval run` works from an install too.
if (fs.existsSync(path.join(root, 'evals', 'cases'))) fs.cpSync(path.join(root, 'evals', 'cases'), path.join(dist, 'evals', 'cases'), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};

const [bridgeBuild] = await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'apps/hook-bridge/src/main.ts')], outfile: path.join(dist, 'plugin/hooks/bridge.mjs'), minify: true, metafile: true }),
  build({ ...common, entryPoints: [path.join(root, 'apps/mcp-server/src/main.ts')], outfile: path.join(dist, 'plugin/mcp/server.mjs'), minify: true }),
  // Fastify and its dependencies are CommonJS and require Node built-ins; an ESM bundle needs a real `require`.
  build({
    ...common,
    entryPoints: [path.join(root, 'apps/core/src/main.ts')],
    outfile: path.join(dist, 'core/core.mjs'),
    banner: { js: "import { createRequire as __jerryCreateRequire } from 'node:module'; const require = __jerryCreateRequire(import.meta.url);" },
  }),
  build({ ...common, entryPoints: [path.join(root, 'apps/cli/src/main.ts')], outfile: path.join(dist, 'cli/jerry.mjs'), banner: { js: '#!/usr/bin/env node' } }),
]);

// The bridge starts on every guarded tool call; it must stay free of heavy dependencies (ADR 0010).
const BRIDGE_FORBIDDEN = [/[\\/]zod@/, /[\\/]kysely@/, /[\\/]fastify@/];
const forbidden = Object.keys(bridgeBuild.metafile.inputs).filter((input) => BRIDGE_FORBIDDEN.some((pattern) => pattern.test(input)));
if (forbidden.length > 0) {
  throw new Error(`The hook bridge bundle must not include heavy dependencies; found:\n  ${forbidden.slice(0, 5).join('\n  ')}`);
}

// Dashboard: Vue components compiled ahead of time (no runtime template compiler, so the page
// runs under a CSP without 'unsafe-eval'); no inlined assets, so the CSP needs no data: scripts.
const dashboardDir = path.join(dist, 'core', 'dashboard');
await viteBuild({
  configFile: false,
  root: path.join(root, 'apps/dashboard'),
  base: '/',
  logLevel: 'warn',
  plugins: [vueJsx()],
  build: { outDir: dashboardDir, emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0, reportCompressedSize: false },
});
writeIcons(path.join(dashboardDir, 'icons'));

for (const file of ['plugin/hooks/bridge.mjs', 'plugin/mcp/server.mjs', 'core/core.mjs', 'cli/jerry.mjs']) {
  const size = fs.statSync(path.join(dist, file)).size;
  console.log(`dist/${file}  ${(size / 1024).toFixed(1)} KiB`);
}
const dashboardBytes = fs
  .readdirSync(path.join(dashboardDir, 'assets'))
  .reduce((sum, name) => sum + fs.statSync(path.join(dashboardDir, 'assets', name)).size, 0);
console.log(`dist/core/dashboard/assets  ${(dashboardBytes / 1024).toFixed(1)} KiB`);
