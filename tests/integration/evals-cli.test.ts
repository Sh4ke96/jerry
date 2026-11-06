import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EvalRunDetail } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, ROOT, startCore, tempDir, type RunningCore } from '../helpers/harness.js';

const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'scripts', 'fake-claude.mjs');

/** jerry eval run records runs in Core, compares with the baseline, blocks on a critical regression. */
describe('jerry eval (CLI + Core, fake claude)', () => {
  const base = tempDir('eval-cli');
  const home = path.join(base, 'home');
  const cases = path.join(base, 'cases');
  let core: RunningCore;

  const writeCase = (expectedText: string) =>
    fs.writeFileSync(
      path.join(cases, 'no-plan-warns.json'),
      JSON.stringify({
        id: 'no-plan-warns',
        title: 'An edit without a plan is warned about',
        suite: 'regression',
        kind: 'approval-gates',
        critical: true,
        fixture: { files: { 'src/app.ts': 'export const answer = 42;\n' } },
        session: { prompt: `FAKE:${JSON.stringify([{ tool: 'Write', input: { file_path: 'src/hello.txt', content: 'hello' } }])}` },
        graders: [{ type: 'file', path: 'src/hello.txt', contains: expectedText }, { type: 'gate', tool: 'Write', verdict: 'WARN' }, { type: 'git-unchanged' }],
      }),
    );
  const jerry = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, JERRY_HOME: home, JERRY_EVAL_CLAUDE: FAKE_CLAUDE }, encoding: 'utf8', windowsHide: true, timeout: 120_000 });

  beforeAll(async () => {
    fs.mkdirSync(cases, { recursive: true });
    core = await startCore(home);
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('lists cases and refuses a broken case instead of skipping it', () => {
    writeCase('hello');
    expect(jerry(['eval', 'list', '--dir', cases]).stdout).toMatch(/no-plan-warns\s+regression\s+approval-gates\s+critical/);
    fs.writeFileSync(path.join(cases, 'broken.json'), '{"id": "Broken"}');
    const run = jerry(['eval', 'run', '--dir', cases]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('invalid');
    fs.rmSync(path.join(cases, 'broken.json'));
  });

  it('records a run, takes it as the baseline, and blocks the release on a critical regression', async () => {
    const first = jerry(['eval', 'run', '--dir', cases, '--label', 'first']);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(first.stdout).toContain('PASS  no-plan-warns #1');
    expect(first.stdout).toMatch(/NEW\s+no-plan-warns/);

    // The baseline is the user's decision: not from a non-interactive shell…
    const refused = jerry(['eval', 'baseline', 'EVR-1', '--note', 'first green run']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('interactive terminal');
    // …but through the token, as the CLI does after the typed confirmation.
    expect((await api(core, 'POST', '/api/v1/evals/baseline', { runId: 'EVR-1', note: 'first green run' })).status).toBe(200);

    writeCase('something else');
    const second = jerry(['eval', 'run', '--dir', cases, '--label', 'broken on purpose']);
    expect(second.status).toBe(2);
    expect(second.stdout).toMatch(/REGRESSION\s+no-plan-warns\s+PASS → FAIL\s+critical/);
    expect(second.stdout).toContain('the JERRY release is blocked');

    const detail = (await api(core, 'GET', '/api/v1/evals/runs/EVR-2')).body as EvalRunDetail;
    expect(detail.comparison).toMatchObject({ baselineRunId: 'EVR-1', regressions: ['no-plan-warns'], releaseBlocked: true });
    expect(jerry(['eval', 'runs']).stdout).toMatch(/EVR-1 .*baseline\s+first/);
    const status = jerry(['eval', 'status']);
    expect(status.stdout).toContain('Baseline: EVR-1');
    expect(status.stdout).toContain('release is blocked');
    // A failed run cannot be made the baseline while it has errors or flaky cases; this one is a clean FAIL.
    expect((await api(core, 'POST', '/api/v1/evals/baseline', { runId: 'EVR-9', note: 'x' })).status).toBe(404);
  });
});
