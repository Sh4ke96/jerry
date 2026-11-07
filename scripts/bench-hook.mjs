// Measures PreToolUse hook latency for the hook launch variants under consideration, and the
// status-line script (Claude Code cancels a status-line run that is still going at the next refresh).
// Usage: pnpm build && node scripts/bench-hook.mjs [iterations]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'dist', 'plugin', 'hooks', 'bridge.mjs');
const statusline = path.join(root, 'dist', 'plugin', 'statusline', 'statusline.mjs');
const core = path.join(root, 'dist', 'core', 'core.mjs');
const iterations = Number(process.argv[2] ?? 20);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-bench-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-bench-repo-'));
spawnSync('git', ['init', '-q', repo]);
const env = { ...process.env, JERRY_HOME: home, JERRY_CORE_PORT: '0' };
// A second home without projects.json (every directory counts) that shares Core's runtime file: the
// status line's slowest path, a snapshot posted to Core (and spooled while Core has no usage route).
const monitoredHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-bench-monitored-'));
const monitoredEnv = { ...env, JERRY_HOME: monitoredHome };

const input = JSON.stringify({
  session_id: 'bench',
  cwd: repo,
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: path.join(repo, 'src', 'a.ts'), content: 'x' },
  tool_use_id: 'toolu_bench',
});

const statusInput = JSON.stringify({
  session_id: 'bench',
  cwd: repo,
  version: 'bench',
  model: { id: 'bench', display_name: 'Bench' },
  cost: { total_cost_usd: 1.2 },
  rate_limits: { five_hour: { used_percentage: 23, resets_at: 1794009600 }, seven_day: { used_percentage: 41, resets_at: 1794441600 } },
});

const variants = {
  'statusline: outside projects': () => spawnSync(process.execPath, [statusline], { input: statusInput, env, encoding: 'utf8', windowsHide: true }),
  'statusline: monitored, posts to Core': () => spawnSync(process.execPath, [statusline], { input: statusInput, env: monitoredEnv, encoding: 'utf8', windowsHide: true }),
  'exec form: node bridge.mjs': () => spawnSync(process.execPath, [bridge, 'pre-tool-use'], { input, env, encoding: 'utf8', windowsHide: true }),
  'shell powershell 5.1: node bridge.mjs': () =>
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$input | & node '${bridge}' pre-tool-use; exit $LASTEXITCODE`], {
      input,
      env,
      encoding: 'utf8',
      windowsHide: true,
    }),
  'baseline: node -e ""': () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true }),
};

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `median ${at(0.5).toFixed(0)} ms, p95 ${at(0.95).toFixed(0)} ms, max ${sorted.at(-1).toFixed(0)} ms`;
}

async function measure(label) {
  for (const [name, run] of Object.entries(variants)) {
    run(); // warm-up
    const samples = [];
    let lastExit;
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      const result = run();
      samples.push(performance.now() - started);
      lastExit = result.status;
    }
    console.log(`${label.padEnd(10)} ${name.padEnd(40)} exit=${lastExit}  ${stats(samples)}`);
  }
}

const child = spawn(process.execPath, [core], { env, stdio: 'ignore', windowsHide: true });
const coreFile = path.join(home, 'run', 'core.json');
for (let i = 0; i < 100 && !fs.existsSync(coreFile); i += 1) await new Promise((r) => setTimeout(r, 50));
fs.mkdirSync(path.join(monitoredHome, 'run'), { recursive: true });
fs.copyFileSync(coreFile, path.join(monitoredHome, 'run', 'core.json'));

console.log(`Node ${process.versions.node}, ${os.cpus()[0]?.model ?? 'cpu?'}, ${iterations} iterations each\n`);
await measure('Core up');
child.kill();
await new Promise((r) => child.once('exit', r));
fs.rmSync(coreFile, { force: true });
fs.rmSync(path.join(monitoredHome, 'run', 'core.json'), { force: true });
await measure('Core down');
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(monitoredHome, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
