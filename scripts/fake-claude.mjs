#!/usr/bin/env node
// A stand-in for the `claude` binary in JERRY's eval tests. It takes the same flags the
// runner passes (-p, --plugin-dir, --output-format json, …). The prompt is a script, not a request:
//
//   FAKE: [{"tool":"Write","input":{"file_path":"src/a.txt","content":"x"}}, {"tool":"Bash","input":{"command":"git commit -m x"}}, {"say":"done"}]
//
// Each tool call goes through the real JERRY hook bridge of --plugin-dir, as Claude Code would send
// it: SessionStart, PreToolUse (a block skips the call), the call itself for Write, PostToolUse.
// The JSON answer has the shape of `claude -p --output-format json`.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const prompt = option('-p') ?? '';
const pluginDir = option('--plugin-dir');
const cwd = process.cwd();
const sessionId = randomUUID();

if (!prompt.startsWith('FAKE:')) {
  // Rubric grading (no plugin): answer with a fixed verdict.
  process.stdout.write(JSON.stringify({ result: '{"score": 1, "reason": "fake grader"}', session_id: sessionId, total_cost_usd: 0 }));
  process.exit(0);
}

const bridge = pluginDir === undefined ? null : path.join(pluginDir, 'hooks', 'bridge.mjs');
const hook = (mode, input) => {
  if (bridge === null) return { status: 0, stdout: '' };
  const result = spawnSync(process.execPath, [bridge, mode], { input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: path.join(cwd, '.fake-transcript.jsonl'), ...input }), encoding: 'utf8', env: process.env, windowsHide: true });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
const said = [];
for (const [index, action] of JSON.parse(prompt.slice('FAKE:'.length)).entries()) {
  if (action.say !== undefined) {
    said.push(action.say);
    continue;
  }
  const toolUseId = `toolu_fake_${index}`;
  const input = { ...action.input };
  if (typeof input.file_path === 'string') input.file_path = path.resolve(cwd, input.file_path);
  const { content, ...toolInput } = input;
  const gate = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: toolInput, tool_use_id: toolUseId });
  if (gate.status === 2) {
    said.push(`${action.tool} was blocked by JERRY`);
    continue;
  }
  if (gate.stdout.includes('JERRY')) said.push(`JERRY said: ${gate.stdout.trim().slice(0, 300)}`);
  if (action.tool === 'Write' && typeof toolInput.file_path === 'string') {
    fs.mkdirSync(path.dirname(toolInput.file_path), { recursive: true });
    fs.writeFileSync(toolInput.file_path, content ?? '');
  }
  hook('event', { hook_event_name: 'PostToolUse', tool_name: action.tool, tool_input: toolInput, tool_response: { success: true }, tool_use_id: toolUseId });
}
hook('event', { hook_event_name: 'Stop', stop_hook_active: false });
process.stdout.write(JSON.stringify({ result: said.join('\n'), session_id: sessionId, total_cost_usd: 0.001 }));
