// Builds a versioned JERRY release package:
//   dist/release/jerry-<version>/        cli, core (with dashboard), plugin, evals, manifest.json, SHA256SUMS, RELEASE-NOTES.md
//   dist/release/jerry-<version>.tar.gz  the same, as one archive, with its .sha256 next to it
//   dist/release/jerry-<version>/desktop/ the optional JERRY Desktop installer, when built
// Usage: node scripts/release.mjs [--skip-build] [--with-desktop] [--dist <dir>]
// The release never contains source maps, tests, the user's data or anything from JERRY_HOME.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The value after `flag`, or undefined. */
function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

// --dist <dir> builds from (and into) another directory; the tests use it with a staged copy.
const dist = path.resolve(option('--dist') ?? path.join(root, 'dist'));
const withDesktop = process.argv.includes('--with-desktop');
const DESKTOP_INSTALLER = /^JERRY-Desktop-(.+)-x64-setup\.exe$/;

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

// JERRY Desktop is optional: --with-desktop builds it (Rust and the C++ Build Tools are needed);
// otherwise an installer already in dist/desktop is included, and without one the release has none.
if (withDesktop) {
  const cargoBin = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin');
  const env = { ...process.env, PATH: fs.existsSync(cargoBin) ? `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH };
  const desktop = spawnSync('corepack pnpm --filter @jerry/desktop build', { cwd: root, stdio: 'inherit', windowsHide: true, shell: true, env });
  if (desktop.status !== 0) fail('the JERRY Desktop build failed');
}
const desktopConfig = path.join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
if (fs.existsSync(desktopConfig)) {
  const desktopVersion = JSON.parse(fs.readFileSync(desktopConfig, 'utf8')).version;
  if (desktopVersion !== version) fail(`JERRY Desktop says ${desktopVersion}, JERRY_VERSION says ${version}; make them equal`);
}
// 'pnpm build' empties dist/, so without dist/desktop the installer is taken straight from Tauri's
// bundle folder (only for the repository's own dist; --dist builds use exactly what they were given).
const TAURI_INSTALLER = /^JERRY Desktop_(.+)_x64-setup\.exe$/;
const tauriBundleDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const desktopDir = path.join(dist, 'desktop');
const fromDist = fs.existsSync(desktopDir)
  ? fs.readdirSync(desktopDir).flatMap((file) => {
      const match = DESKTOP_INSTALLER.exec(file);
      return match === null ? [] : [{ file: path.join(desktopDir, file), version: match[1] }];
    })
  : [];
const fromBundle =
  fromDist.length === 0 && option('--dist') === undefined && fs.existsSync(tauriBundleDir)
    ? fs.readdirSync(tauriBundleDir).flatMap((file) => {
        const match = TAURI_INSTALLER.exec(file);
        return match === null ? [] : [{ file: path.join(tauriBundleDir, file), version: match[1] }];
      })
    : [];
const found = fromDist.length > 0 ? fromDist : fromBundle;
const stale = found.filter((installer) => installer.version !== version);
if (stale.length > 0) fail(`found a JERRY Desktop installer of another version (${stale.map((installer) => path.basename(installer.file)).join(', ')}); rebuild it with --with-desktop`);
const desktopSource = found[0]?.file;
const desktopInstaller = desktopSource === undefined ? undefined : `JERRY-Desktop-${version}-x64-setup.exe`;
if (withDesktop && desktopInstaller === undefined) fail('the JERRY Desktop build left no installer in dist/desktop');

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
if (desktopSource !== undefined && desktopInstaller !== undefined) {
  fs.mkdirSync(path.join(stage, 'desktop'), { recursive: true });
  fs.copyFileSync(desktopSource, path.join(stage, 'desktop', desktopInstaller));
}
const desktopNotes =
  desktopInstaller === undefined
    ? ['## 🖥️ JERRY Desktop', '', 'Not included in this package. Build it with `pnpm release --with-desktop` (needs Rust and the C++ Build Tools).', '']
    : [
        '## 🖥️ JERRY Desktop (optional)',
        '',
        `\`desktop/${desktopInstaller}\` installs the desktop app for your Windows user, no admin needed: the dashboard in its own`,
        'window, a tray icon with JERRY\'s state, notifications and Start/Stop Core. JERRY works without it. The installer is',
        'not code-signed, so Windows SmartScreen may ask once ("More info" → "Run anyway"); check SHA256SUMS first.',
        '',
      ];

fs.writeFileSync(
  path.join(stage, 'RELEASE-NOTES.md'),
  [
    `# 🛡️ JERRY ${version}`,
    '',
    `Built ${new Date().toISOString().slice(0, 10)}. Requires Node.js 22.13 or newer and Claude Code.`,
    '',
    '## 📦 What is inside',
    '',
    '- `cli/`: the `jerry` command line.',
    '- `core/`: JERRY Core, the local service on 127.0.0.1, with the dashboard.',
    '- `plugin/`: the Claude Code plugin (hooks, MCP server, skills, agents).',
    '- `evals/`: the golden eval cases.',
    '- `manifest.json` and `SHA256SUMS`: a checksum for every file.',
    '',
    ...desktopNotes,
    '## ⬆️ Install or update',
    '',
    '1. Unpack the archive anywhere (not inside a project repository).',
    '2. Check it: compare SHA256SUMS with the files (or the archive with its .sha256).',
    `3. Run \`node ${name}/cli/jerry.mjs install\`, then restart Claude Code sessions and Core (\`jerry core stop\`, \`jerry core start\`).`,
    '   Your JERRY data stays in JERRY_HOME; the database is backed up before every migration.',
    '',
    '## ↩️ Roll back',
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
