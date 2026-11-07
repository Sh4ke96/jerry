// Copies the NSIS installer built by "tauri build" to <repo>/dist/desktop/JERRY-Desktop-<version>-x64-setup.exe,
// where scripts/release.mjs picks it up. Older JERRY-Desktop-*.exe files there are removed first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = config.version;
const bundleDir = path.join(desktop, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

function fail(message) {
  console.error(`copy-installer: ${message}`);
  process.exit(1);
}

if (typeof version !== 'string' || version === '') fail('tauri.conf.json has no version');
if (!fs.existsSync(bundleDir)) fail(`${bundleDir} does not exist; run "tauri build --bundles nsis" first`);

// The bundle name carries the product name and version: "JERRY Desktop_0.1.0_x64-setup.exe".
const built = fs
  .readdirSync(bundleDir)
  .filter((file) => file.endsWith('-setup.exe') && file.includes(`_${version}_`))
  .map((file) => path.join(bundleDir, file));
if (built.length === 0) fail(`no installer for version ${version} in ${bundleDir}`);
if (built.length > 1) fail(`more than one installer for version ${version} in ${bundleDir}: ${built.join(', ')}`);

const outDir = path.join(root, 'dist', 'desktop');
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(outDir)) {
  if (/^JERRY-Desktop-.*\.exe$/.test(file)) fs.rmSync(path.join(outDir, file), { force: true });
}
const target = path.join(outDir, `JERRY-Desktop-${version}-x64-setup.exe`);
fs.copyFileSync(built[0], target);
console.log(`copy-installer: ${path.relative(root, target)} (${fs.statSync(target).size} bytes)`);
