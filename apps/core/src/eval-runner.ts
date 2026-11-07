import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EvalRunnerStartRequest, EvalRunnerStatus } from '@jerry/contracts';
import { loadCases } from '@jerry/evals';
import { jerryPaths } from '@jerry/platform';

/**
 * "jerry eval run" started from the dashboard. Core runs the CLI that ships next to it as a child
 * process (node <cli> eval run [--suite s] [--label l], arguments as a list, no shell) with this
 * Core's JERRY_HOME, so the CLI records the run with this Core as usual. One run at a time; its
 * output goes to JERRY_HOME/run/eval-runs/<time>.log and the last lines are kept for the
 * dashboard. Stop ends the CLI and everything it started (Claude Code sessions, fixture Cores).
 */

export interface EvalRunnerOptions {
  home: string;
  /** The CLI bundle (dist/cli/jerry.mjs); null when this Core has none next to it. */
  cliPath: string | null;
  /** The bundled eval cases (dist/evals/cases), to say how many a run starts. */
  casesDir: string | null;
  /** The runtime that runs the CLI (this Node by default). */
  nodePath?: string;
}

/** Output lines kept for the dashboard. */
const TAIL_LINES = 40;
/** A line longer than this is shortened in the tail (the log file keeps it whole). */
const MAX_LINE = 400;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

interface Current {
  child: ChildProcess;
  startedAt: Date;
  suite: string | null;
  label: string;
  logFile: string;
  log: fs.WriteStream;
  stopped: boolean;
}

interface Finished {
  state: 'finished' | 'failed' | 'stopped';
  startedAt: Date;
  finishedAt: Date;
  exitCode: number | null;
  suite: string | null;
  label: string;
  logFile: string;
}

export class EvalRunnerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class EvalRunner {
  private current: Current | null = null;
  private last: Finished | null = null;
  private tail: string[] = [];
  private partial = '';

  constructor(private readonly options: EvalRunnerOptions) {}

  /** Why a run cannot start here; null when it can. */
  unavailable(): string | null {
    if (this.options.cliPath === null || !fs.existsSync(this.options.cliPath)) return 'The jerry CLI is not next to this Core (dist/cli/jerry.mjs); run "jerry eval run" in a terminal.';
    return null;
  }

  /** The cases a run would start, per suite (empty when the cases cannot be read). */
  suites(): Array<{ suite: string; cases: number }> {
    if (this.options.casesDir === null || !fs.existsSync(this.options.casesDir)) return [];
    try {
      const counts = new Map<string, number>();
      for (const evalCase of loadCases(this.options.casesDir).cases) counts.set(evalCase.suite, (counts.get(evalCase.suite) ?? 0) + 1);
      return [...counts].map(([suite, cases]) => ({ suite, cases })).sort((a, b) => a.suite.localeCompare(b.suite));
    } catch {
      return [];
    }
  }

  status(): Omit<EvalRunnerStatus, 'runId'> {
    const base = { logTail: [...this.tail], unavailable: this.unavailable(), suites: this.suites() };
    if (this.current !== null) {
      const { startedAt, suite, label, logFile } = this.current;
      return { state: 'running', startedAt: startedAt.toISOString(), finishedAt: null, exitCode: null, suite, label, logFile, ...base };
    }
    if (this.last !== null) {
      const { state, startedAt, finishedAt, exitCode, suite, label, logFile } = this.last;
      return { state, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), exitCode, suite, label, logFile, ...base };
    }
    return { state: 'idle', startedAt: null, finishedAt: null, exitCode: null, suite: null, label: '', logFile: null, ...base };
  }

  /** When the last finished run started (to find the run it recorded). */
  lastStartedAt(): Date | null {
    return this.current === null ? (this.last?.startedAt ?? null) : null;
  }

  start(request: EvalRunnerStartRequest, now: Date = new Date()): void {
    if (this.current !== null) throw new EvalRunnerError(409, 'An eval run is already running; wait for it or stop it.');
    const unavailable = this.unavailable();
    if (unavailable !== null) throw new EvalRunnerError(503, unavailable);
    if (request.suite !== null && !this.suites().some((entry) => entry.suite === request.suite)) throw new EvalRunnerError(400, `There is no eval suite "${request.suite}".`);
    const dir = path.join(jerryPaths(this.options.home).runDir, 'eval-runs');
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.log`);
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const args = [this.options.cliPath!, 'eval', 'run', ...(request.suite === null ? [] : ['--suite', request.suite]), ...(request.label === '' ? [] : ['--label', request.label])];
    const child = spawn(this.options.nodePath ?? process.execPath, args, {
      env: { ...process.env, JERRY_HOME: this.options.home, JERRY_NO_EMOJI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.tail = [];
    this.partial = '';
    this.current = { child, startedAt: now, suite: request.suite, label: request.label, logFile, log, stopped: false };
    const take = (chunk: Buffer): void => {
      log.write(chunk);
      this.addOutput(chunk.toString('utf8'));
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const finish = (exitCode: number | null): void => {
      const current = this.current;
      if (current === null || current.child !== child) return;
      if (this.partial !== '') this.pushLine(this.partial);
      this.partial = '';
      current.log.end();
      this.current = null;
      this.last = { state: current.stopped ? 'stopped' : exitCode === 0 ? 'finished' : 'failed', startedAt: current.startedAt, finishedAt: new Date(), exitCode, suite: current.suite, label: current.label, logFile: current.logFile };
    };
    child.on('error', (error) => {
      this.pushLine(`Could not start the CLI: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  }

  /** Ends the running CLI and what it started; nothing happens when no run is running. */
  stop(): void {
    const current = this.current;
    if (current === null) return;
    current.stopped = true;
    const pid = current.child.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      // The whole tree: the CLI started Claude Code sessions and fixture Cores.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      current.child.kill('SIGTERM');
    }
  }

  /** Resolves once no run is running (tests, and Core's shutdown after stop()). */
  async idle(): Promise<void> {
    while (this.current !== null) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private addOutput(text: string): void {
    const lines = (this.partial + text.replace(ANSI, '')).split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.pushLine(line);
  }

  private pushLine(line: string): void {
    if (line.trim() === '') return;
    this.tail.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
  }
}
