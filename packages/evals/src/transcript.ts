/**
 * What an eval session cost and did, read from Claude Code's headless output
 * (`--output-format stream-json --verbose`: one JSON object per line, ending with a `result`
 * message). Defensive: every field may be missing in another Claude Code version; what is missing
 * stays null instead of failing the attempt. A single JSON object (`--output-format json`) is read
 * as the result as well.
 */

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface SessionTranscript {
  /** False when the output held no result message: the session did not finish. */
  finished: boolean;
  output: string;
  sessionId: string | null;
  costUsd: number | null;
  /** All models, subagents included (modelUsage), else the main loop's usage. */
  tokens: SessionTokens | null;
  turns: number | null;
  durationMs: number | null;
  /** Tool calls by tool name, each tool_use block counted once (parallel calls share a message id). */
  toolCalls: Record<string, number>;
  /** Plugins and MCP servers the session loaded (system/init); null when not reported. */
  plugins: string[] | null;
  mcpServers: string[] | null;
}

type Fields = Record<string, unknown>;

const record = (value: unknown): Fields | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const names = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry : String(record(entry)?.['name'] ?? ''))).filter((name) => name !== '')
    : null;

function tokensOf(result: Fields): SessionTokens | null {
  // modelUsage covers every model the session used, subagents included.
  const perModel = record(result['modelUsage']);
  if (perModel !== null && Object.keys(perModel).length > 0) {
    const total: SessionTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const usage of Object.values(perModel)) {
      const fields = record(usage);
      if (fields === null) continue;
      total.input += count(fields['inputTokens']) ?? 0;
      total.output += count(fields['outputTokens']) ?? 0;
      total.cacheRead += count(fields['cacheReadInputTokens']) ?? 0;
      total.cacheCreation += count(fields['cacheCreationInputTokens']) ?? 0;
    }
    return total;
  }
  const usage = record(result['usage']);
  if (usage === null) return null;
  return {
    input: count(usage['input_tokens']) ?? 0,
    output: count(usage['output_tokens']) ?? 0,
    cacheRead: count(usage['cache_read_input_tokens']) ?? 0,
    cacheCreation: count(usage['cache_creation_input_tokens']) ?? 0,
  };
}

export function parseTranscript(stdout: string): SessionTranscript {
  const transcript: SessionTranscript = { finished: false, output: '', sessionId: null, costUsd: null, tokens: null, turns: null, durationMs: null, toolCalls: {}, plugins: null, mcpServers: null };
  const seenToolUses = new Set<string>();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (const line of lines) {
    let message: Fields | null;
    try {
      message = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (message === null) continue;
    const type = message['type'];
    if (type === 'system' && message['subtype'] === 'init') {
      transcript.plugins = names(message['plugins']);
      transcript.mcpServers = names(message['mcp_servers']);
      if (typeof message['session_id'] === 'string') transcript.sessionId = message['session_id'];
    } else if (type === 'assistant') {
      const content = record(message['message'])?.['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const fields = record(block);
        if (fields?.['type'] !== 'tool_use' || typeof fields['name'] !== 'string') continue;
        const id = typeof fields['id'] === 'string' ? fields['id'] : `${line.length}:${seenToolUses.size}`;
        if (seenToolUses.has(id)) continue;
        seenToolUses.add(id);
        transcript.toolCalls[fields['name']] = (transcript.toolCalls[fields['name']] ?? 0) + 1;
      }
    } else if (type === 'result' || (type === undefined && 'result' in message)) {
      transcript.finished = true;
      transcript.output = String(message['result'] ?? '');
      if (typeof message['session_id'] === 'string') transcript.sessionId = message['session_id'];
      transcript.costUsd = count(message['total_cost_usd']);
      transcript.tokens = tokensOf(message);
      transcript.turns = count(message['num_turns']);
      transcript.durationMs = count(message['duration_ms']);
    }
  }
  return transcript;
}

/** Input, output and cache tokens together. */
export function totalTokens(tokens: SessionTokens | null): number | null {
  return tokens === null ? null : tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/** Tools Claude used to search and read code (what history should reduce). */
export const SEARCH_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

export function searchCalls(toolCalls: Readonly<Record<string, number>>): number {
  return SEARCH_TOOLS.reduce((sum, tool) => sum + (toolCalls[tool] ?? 0), 0);
}
