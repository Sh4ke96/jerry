#!/usr/bin/env node
// A stand-in for the `claude` binary in JERRY's eval tests. It takes the same flags the
// runner passes (-p, --plugin-dir, --output-format json|stream-json, --disallowedTools, …). The
// prompt is a script, not a request:
//
//   FAKE: [{"tool":"Write","input":{"file_path":"src/a.txt","content":"x"}}, {"tool":"Bash","input":{"command":"git commit -m x"}}, {"say":"done"}]
//
// Each tool call goes through the real JERRY hook bridge of --plugin-dir, as Claude Code would send
// it: SessionStart, PreToolUse (a block skips the call), the call itself for Write, PostToolUse.
// {"tool":"mcp__plugin_jerry_guardian__get_history","input":{"paths":[...]}} asks the session's JERRY
// Core for the history (as the MCP tool would) and says what it found. A tool named in
// --disallowedTools is not available and is skipped.
// The answer has the shape of `claude -p --output-format json`, or, with stream-json, an init line,
// one assistant line per tool call and a result line with usage.
// FAKE_CLAUDE_ARGS_FILE: where to write the arguments and the environment flags it saw (for tests).
// FAKE_CLAUDE_EXTRA_PLUGIN: a plugin name to report as loaded besides JERRY's.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
/** Values of a flag that takes several (up to the next flag). */
const options = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return [];
  const values = [];
  for (let next = index + 1; next < args.length && !args[next].startsWith('--'); next += 1) values.push(args[next]);
  return values;
};
const prompt = option('-p') ?? '';
const pluginDir = option('--plugin-dir');
const stream = option('--output-format') === 'stream-json';
const disallowed = new Set(options('--disallowedTools'));
const cwd = process.cwd();
const sessionId = randomUUID();

if (process.env.FAKE_CLAUDE_ARGS_FILE !== undefined) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, `${JSON.stringify({ args, disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null })}\n`);
}

const lines = [];
const emit = (message) => lines.push(JSON.stringify(message));
const finish = (result, costUsd, toolUses) => {
  const usage = { input_tokens: 100 + 10 * toolUses, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
  const message = { type: 'result', subtype: 'success', result, session_id: sessionId, total_cost_usd: costUsd, num_turns: toolUses + 1, duration_ms: 1200, usage, modelUsage: { 'claude-fake': { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens, costUSD: costUsd } } };
  if (stream) {
    emit(message);
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(JSON.stringify({ result, session_id: sessionId, total_cost_usd: costUsd }));
  }
};

if (!prompt.startsWith('FAKE:')) {
  // Rubric grading (no plugin): answer with a fixed verdict.
  process.stdout.write(JSON.stringify({ result: '{"score": 1, "reason": "fake grader"}', session_id: sessionId, total_cost_usd: 0 }));
  process.exit(0);
}

// Like Claude Code, a plugin directory that does not exist does not load.
const plugins = [...(pluginDir === undefined || !fs.existsSync(pluginDir) ? [] : [{ name: 'jerry', path: pluginDir }]), ...(process.env.FAKE_CLAUDE_EXTRA_PLUGIN === undefined ? [] : [{ name: process.env.FAKE_CLAUDE_EXTRA_PLUGIN, path: 'elsewhere' }])];
emit({ type: 'system', subtype: 'init', session_id: sessionId, plugins, mcp_servers: pluginDir === undefined ? [] : [{ name: 'plugin:jerry:guardian', status: 'connected' }] });

const bridge = pluginDir === undefined ? null : path.join(pluginDir, 'hooks', 'bridge.mjs');
const hook = (mode, input) => {
  if (bridge === null) return { status: 0, stdout: '' };
  const result = spawnSync(process.execPath, [bridge, mode], { input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: path.join(cwd, '.fake-transcript.jsonl'), ...input }), encoding: 'utf8', env: process.env, windowsHide: true });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** GET from the session's JERRY Core, as JERRY's MCP server would. */
const askCore = (apiPath) =>
  new Promise((resolve) => {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(process.env.JERRY_HOME ?? '', 'run', 'core.json'), 'utf8'));
      const call = http.get({ host: '127.0.0.1', port: info.port, path: apiPath, headers: { authorization: `Bearer ${info.token}` } }, (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(text));
      });
      call.on('error', (error) => resolve(`error: ${error.message}`));
    } catch (error) {
      resolve(`error: ${error.message}`);
    }
  });

hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
const said = [];
let toolUses = 0;
for (const [index, action] of JSON.parse(prompt.slice('FAKE:'.length)).entries()) {
  if (action.say !== undefined) {
    said.push(action.say);
    continue;
  }
  if (disallowed.has(action.tool)) {
    said.push(`${action.tool} is not available`);
    continue;
  }
  const toolUseId = `toolu_fake_${index}`;
  toolUses += 1;
  emit({ type: 'assistant', session_id: sessionId, message: { id: `msg_${index}`, content: [{ type: 'tool_use', id: toolUseId, name: action.tool, input: action.input ?? {} }] } });
  if (action.tool === 'mcp__plugin_jerry_guardian__get_history') {
    if (pluginDir === undefined) {
      said.push('get_history is not available');
      continue;
    }
    const query = new URLSearchParams({ repoPath: cwd });
    for (const entry of action.input?.paths ?? []) query.append('paths', entry);
    said.push(`history: ${await askCore(`/api/v1/history?${query.toString()}`)}`);
    continue;
  }
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
finish(said.join('\n'), 0.001, toolUses);
