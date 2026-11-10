import path from 'node:path';
import readline from 'node:readline/promises';
import { findingEventSchema, findingSchema, type Finding } from '@jerry/contracts';
import { readCoreRuntimeInfoForUser, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import { mark, severityMark } from './emoji.js';

/**
 * `jerry findings`: quality findings in a terminal. Listing and showing are read-only;
 * changing a status is the user's decision, so it needs an interactive terminal (an agent's shell
 * is not one) and a reason.
 */

async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfoForUser(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs: 5000, ...(body === undefined ? {} : { body }) });
}

const SEVERITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;

function line(finding: Finding): string {
  return severityMark(finding.severity, `${finding.findingId.padEnd(8)} ${finding.severity} ${finding.status.padEnd(14)} ${`${finding.file}:${finding.lineStart}`.padEnd(40)} ${finding.title} [${finding.ruleId}]`);
}

export async function listFindings(options: { task?: string; repo?: string; all: boolean }): Promise<void> {
  const params = new URLSearchParams();
  if (options.task !== undefined) params.set('taskId', options.task.toUpperCase());
  if (options.repo !== undefined) params.set('repoPath', path.resolve(options.repo));
  if (!options.all) params.set('status', 'OPEN,ACCEPTED');
  const findings = z.array(findingSchema).parse(await callCore('GET', `/api/v1/findings?${params.toString()}`));
  if (findings.length === 0) {
    console.log(mark('pass', options.all ? 'No findings.' : 'No open findings (--all shows fixed and dismissed ones too).'));
    return;
  }
  for (const finding of [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.lineStart - b.lineStart)) {
    console.log(line(finding));
  }
}

export async function showFinding(findingId: string): Promise<void> {
  const detail = findingSchema.extend({ history: z.array(findingEventSchema) }).parse(await callCore('GET', `/api/v1/findings/${encodeURIComponent(findingId.toUpperCase())}`));
  console.log(line(detail));
  console.log(`  task:       ${detail.taskId ?? 'none'} · ${detail.repoRoot}`);
  console.log(`  rule:       ${detail.ruleId} ${detail.ruleVersion} (${detail.source}, ${detail.category}, confidence ${detail.confidence})`);
  console.log(`  evidence:   ${detail.evidence}`);
  console.log(`  why:        ${detail.whyItMatters}`);
  console.log(`  fix:        ${detail.suggestedFix}`);
  if (detail.statusReason !== '') console.log(`  reason:     ${detail.statusReason}`);
  console.log(`  ${mark('task', 'history:')}`);
  for (const step of detail.history) console.log(`    ${step.at}  ${(step.from ?? 'new').padEnd(14)} -> ${step.to.padEnd(14)} by ${step.actor}: ${step.reason}`);
}

const DECISIONS = ['OPEN', 'ACCEPTED', 'WONT_FIX', 'FALSE_POSITIVE'] as const;

export async function setFindingStatus(findingId: string, status: string, options: { reason?: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Changing a finding requires an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".');
  }
  const decision = status.toUpperCase().replace('-', '_');
  if (!(DECISIONS as readonly string[]).includes(decision)) throw new Error(`Status must be one of ${DECISIONS.join(', ')} (FIXED is set by JERRY when the problem is gone).`);
  await showFinding(findingId);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reason = options.reason?.trim() || (await prompt.question(`\nWhy ${decision}? `)).trim();
    if (reason === '') throw new Error('A reason is required; nothing changed.');
    const saved = findingSchema.parse(await callCore('POST', `/api/v1/findings/${encodeURIComponent(findingId.toUpperCase())}/status`, { status: decision, reason }));
    console.log(`\n${mark('pass', `${saved.findingId} is now ${saved.status}.`)}`);
  } finally {
    prompt.close();
  }
}
