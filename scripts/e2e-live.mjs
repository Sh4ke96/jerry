// M0 spike, live check: runs real headless Claude Code sessions with the JERRY plugin loaded via
// --plugin-dir (session-only; Claude settings are not modified) against a temporary fixture repo.
// Uses the signed-in Claude account and a small model. Opt-in: pnpm build && node scripts/e2e-live.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'dist', 'plugin');
const coreBundle = path.join(root, 'dist', 'core', 'core.mjs');
const model = process.env.JERRY_LIVE_MODEL ?? 'haiku';

function findClaude() {
  if (process.env.JERRY_CLAUDE_BIN) return process.env.JERRY_CLAUDE_BIN;
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  const dirs = fs.existsSync(extensions) ? fs.readdirSync(extensions).filter((d) => d.startsWith('anthropic.claude-code-')).sort() : [];
  for (const dir of dirs.reverse()) {
    const candidate = path.join(extensions, dir, 'resources', 'native-binary', 'claude.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'claude';
}
const claude = findClaude();

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-live-')));
const home = path.join(base, 'jerry-home');
const repo = path.join(base, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'README.md'), '# live fixture\n');
fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const answer = 42;\n');
const git = (...args) => spawnSync('git', ['-c', 'user.name=JERRY Test', '-c', 'user.email=jerry-test@example.invalid', '-C', repo, ...args], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-q', '-m', 'initial');

const env = { ...process.env, JERRY_HOME: home };
const results = [];
const expect = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

let coreProcess = null;
async function startCore() {
  coreProcess = spawn(process.execPath, [coreBundle], { env, stdio: 'ignore', windowsHide: true });
  const coreFile = path.join(home, 'run', 'core.json');
  for (let i = 0; i < 100 && !fs.existsSync(coreFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(fs.readFileSync(coreFile, 'utf8'));
}
async function stopCore() {
  coreProcess.kill();
  await new Promise((r) => coreProcess.once('exit', r));
  fs.rmSync(path.join(home, 'run', 'core.json'), { force: true });
}
async function coreApi(info, method, apiPath, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

function runClaude(label, prompt, allowedTools) {
  const args = ['-p', prompt, '--plugin-dir', pluginDir, '--model', model, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--no-session-persistence', '--allowedTools', ...allowedTools];
  const started = Date.now();
  const result = spawnSync(claude, args, { cwd: repo, env, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // keep raw output for the report
  }
  const text = parsed?.result ?? result.stdout ?? '';
  console.log(`\n--- ${label} (exit ${result.status}, ${((Date.now() - started) / 1000).toFixed(1)} s, session ${parsed?.session_id ?? '?'})`);
  console.log(String(text).trim().slice(0, 600));
  if (result.stderr?.trim()) console.log(`[stderr] ${result.stderr.trim().slice(0, 400)}`);
  return { sessionId: parsed?.session_id ?? null, text: String(text), denials: parsed?.permission_denials ?? [] };
}

function gateLog() {
  const file = path.join(home, 'logs', 'gate-decisions.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
const exists = (relative) => fs.existsSync(path.join(repo, relative));

console.log(`claude: ${claude}\nmodel: ${model}\nfixture: ${repo}\nJERRY_HOME: ${home}\n`);
let info = await startCore();

// A — no plan: Write must be blocked by the hook even though acceptEdits + allowedTools permit it.
const a = runClaude(
  'A: Write without approved plan',
  'Use the Write tool to create the file hello.txt in the current directory with the content "hi". Do not use any other tool. If the Write tool is blocked, do not retry or work around it; reply with the exact error message you received.',
  ['Write'],
);
expect('A: hello.txt was not created', !exists('hello.txt'));
expect('A: gate denied Write (write.no-approved-plan)', gateLog().some((e) => e.sessionId === a.sessionId && e.toolName === 'Write' && e.ruleId === 'write.no-approved-plan'));

// B — no plan: write-capable shell commands blocked for both Bash and PowerShell tools.
const b = runClaude(
  'B: shell writes without approved plan',
  'Do exactly these two steps and nothing else. Step 1: use the Bash tool to run exactly: touch bash.txt  Step 2: use the PowerShell tool to run exactly: Set-Content -Path ps.txt -Value hi  If a step is blocked, do not retry or work around it; report the exact error message for each step. If a tool is not available to you, say so.',
  ['Bash(touch bash.txt)', 'PowerShell(Set-Content -Path ps.txt -Value hi)'],
);
const bLog = gateLog().filter((e) => e.sessionId === b.sessionId);
expect('B: bash.txt was not created', !exists('bash.txt'));
expect('B: ps.txt was not created', !exists('ps.txt'));
expect('B: gate denied Bash command', bLog.some((e) => e.toolName === 'Bash' && e.verdict === 'DENY'), bLog.map((e) => `${e.toolName}:${e.ruleId}`).join(', '));
expect('B: gate denied PowerShell command', bLog.some((e) => e.toolName === 'PowerShell' && e.verdict === 'DENY'), 'requires the PowerShell tool to be enabled in this Claude Code session');

// C — approved plan with scope src/**: in-scope write passes, out-of-scope write is blocked.
const task = await coreApi(info, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Live spike', scope: ['src/**'] });
await coreApi(info, 'POST', `/api/v1/tasks/${task.taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED', comment: 'live spike' });
const c = runClaude(
  'C: approved plan, scope src/**',
  'Do exactly these two steps with the Write tool and nothing else. Step 1: create src/hello.txt with the content "hi". Step 2: create outside.txt (in the current directory, not in src) with the content "hi". If a step is blocked, do not retry or work around it; report the exact error message for each step.',
  ['Write'],
);
const cLog = gateLog().filter((e) => e.sessionId === c.sessionId);
expect('C: src/hello.txt created (in approved scope)', exists('src/hello.txt'));
expect('C: outside.txt not created (out of scope)', !exists('outside.txt'));
expect('C: gate log shows PASS in-scope and DENY out-of-scope', cLog.some((e) => e.ruleId === 'write.in-approved-scope') && cLog.some((e) => e.ruleId === 'write.out-of-scope'));

// SessionStart hook registered every live session with Core.
const state = JSON.parse(fs.readFileSync(path.join(home, 'state', 'core-state.json'), 'utf8'));
const registered = new Set(state.sessions.map((s) => s.sessionId));
expect('SessionStart hook registered all sessions', [a, b, c].every((run) => run.sessionId !== null && registered.has(run.sessionId)), `${registered.size} session(s) registered`);

// D — Core down: writes fail closed even inside the approved scope.
await stopCore();
const d = runClaude(
  'D: Core stopped',
  'Use the Write tool to create src/down.txt with the content "hi". Do not use any other tool. If the Write tool is blocked, do not retry or work around it; reply with the exact error message.',
  ['Write'],
);
expect('D: src/down.txt not created (fail-closed)', !exists('src/down.txt'));
expect('D: Claude saw the core.unavailable reason', /core\.unavailable|Core is unavailable/i.test(d.text) || JSON.stringify(d.denials).includes('core.unavailable'));

// Zero footprint: the only change is the file the approved plan allowed.
const status = git('status', '--porcelain', '--untracked-files=all').stdout.trim().split('\n').filter(Boolean);
expect('Repo diff is exactly the approved write', status.length === 1 && status[0] === '?? src/hello.txt', status.join(' | '));
expect('No JERRY or harness files in repo', !['.jerry', '.harness'].some(exists), exists('.claude') ? 'note: .claude/ exists (created by Claude Code, not JERRY)' : '');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Artifacts kept in ${base}`);
process.exitCode = failed.length === 0 ? 0 : 1;
