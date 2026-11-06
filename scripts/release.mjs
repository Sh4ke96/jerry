// Builds a versioned JERRY release package (ADR 0043):
//   dist/release/jerry-<version>/        cli, core (with dashboard), plugin, evals, manifest.json, SHA256SUMS, RELEASE-NOTES.md
//   dist/release/jerry-<version>.tar.gz  the same, as one archive, with its .sha256 next to it
// Usage: node scripts/release.mjs [--skip-build]
// The release never contains source maps, tests, the user's data or anything from JERRY_HOME.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (!process.argv.includes('--skip-build')) {
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) fail('the build failed');
}

const constants = fs.readFileSync(path.join(root, 'packages', 'contracts', 'src', 'constants.ts'), 'utf8');
const version = /export const JERRY_VERSION = '([^']+)'/.exec(constants)?.[1];
if (version === undefined) fail('JERRY_VERSION not found');
const pluginVersion = JSON.parse(fs.readFileSync(path.join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
if (pluginVersion !== version) fail(`the plugin manifest says ${pluginVersion}, JERRY_VERSION says ${version}; make them equal`);
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`${version} is not a semantic version`);

const name = `jerry-${version}`;
const releaseDir = path.join(dist, 'release');
const stage = path.join(releaseDir, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const part of ['cli', 'core', 'plugin', 'evals']) {
  const source = path.join(dist, part);
  if (!fs.existsSync(source)) fail(`dist/${part} is missing; run the build`);
  fs.cpSync(source, path.join(stage, part), { recursive: true, filter: (file) => !file.endsWith('.map') && !file.includes(`${path.sep}results${path.sep}`) });
}

// Release notes: the milestones the roadmap marks as done.
const roadmap = fs.readFileSync(path.join(root, 'docs', 'roadmap.md'), 'utf8');
const done = (/## Done\n([\s\S]*?)\n## /.exec(roadmap)?.[1] ?? '').split('\n').filter((line) => line.startsWith('- ')).map((line) => line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
fs.writeFileSync(
  path.join(stage, 'RELEASE-NOTES.md'),
  [
    `# JERRY ${version}`,
    '',
    `Built ${new Date().toISOString().slice(0, 10)}. Requires Node.js 22.13 or newer and Claude Code.`,
    '',
    '## Included milestones',
    '',
    ...done,
    '',
    '## Install or update',
    '',
    '1. Unpack the archive anywhere (not inside a project repository).',
    '2. Check it: compare SHA256SUMS with the files (or the archive with its .sha256).',
    `3. Run \`node ${name}/cli/jerry.mjs install\`, then restart Claude Code sessions and Core (\`jerry core stop\`, \`jerry core start\`).`,
    '   Your JERRY data stays in JERRY_HOME; the database is backed up before every migration.',
    '',
    '## Roll back',
    '',
    'Run `install` from the previous version\'s package. Data is kept; a newer database is still readable by older Cores',
    'for the tables they know. If needed, restore a pre-migration backup with `jerry db restore` (interactive).',
    '',
  ].join('\n'),
);

// Manifest with a checksum per file, and SHA256SUMS in the common format.
const files = (fs.readdirSync(stage, { recursive: true })).map(String).filter((entry) => fs.statSync(path.join(stage, entry)).isFile()).sort();
const entries = files.map((file) => {
  const content = fs.readFileSync(path.join(stage, file));
  return { path: file.split(path.sep).join('/'), size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
});
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify({ name: 'jerry', version, builtAt: new Date().toISOString(), node: '>=22.13', files: entries }, null, 2)}\n`);
fs.writeFileSync(path.join(stage, 'SHA256SUMS'), entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n');

const archive = path.join(releaseDir, `${name}.tar.gz`);
fs.rmSync(archive, { force: true });
// Relative paths only: GNU tar (Git for Windows) reads "D:\…" as a remote host.
const tar = spawnSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: releaseDir, stdio: 'inherit', windowsHide: true });
if (tar.status !== 0) fail('tar failed');
const archiveHash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${archiveHash}  ${name}.tar.gz\n`);
console.log(`release: ${name} (${entries.length} files) → ${path.relative(root, archive)}\nsha256 ${archiveHash}`);
