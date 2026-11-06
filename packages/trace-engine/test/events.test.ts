import { eventEnvelopeSchema } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { buildEventEnvelope } from '../src/events.js';
import { redactText } from '../src/redaction.js';

const common = { session_id: 's1', cwd: 'D:/Work/Repo', transcript_path: 'C:/t.jsonl' };

describe('redactText', () => {
  it.each([
    ['curl -H "Authorization: Bearer abc.def.ghi" https://api', 'authorization-header'],
    ['psql postgres://admin:hunter2@db:5432/app', 'url-credentials'],
    ['export API_KEY=supersecretvalue123', 'credential-assignment'],
    ['set DB_PASSWORD="p@ss word"', 'credential-assignment'],
    ['mysql -u root --password hunter2', 'credential-flag'],
    ['git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y', 'github-token'],
    ['ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyz node x', 'api-key'],
    ['aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['curl -b "Cookie: session=abcdef"', 'cookie-header'],
  ])('masks %s', (input, reason) => {
    const result = redactText(input);
    expect(result.reasons).toContain(reason);
    expect(result.text).toContain('[REDACTED]');
  });

  it('leaves ordinary commands untouched', () => {
    expect(redactText('npm test -- --run src/app.test.ts')).toEqual({ text: 'npm test -- --run src/app.test.ts', reasons: [] });
  });

  it('never leaves the secret value in the text', () => {
    expect(redactText('psql postgres://admin:hunter2@db/app').text).not.toContain('hunter2');
    expect(redactText('mysql --password=hunter2').text).not.toContain('hunter2');
  });
});

describe('buildEventEnvelope: data minimization', () => {
  it('records the target path of a Write, never its content', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: 'D:/Work/Repo/.env', content: 'SECRET=topsecret' }, tool_response: { success: true, filePath: 'D:/Work/Repo/.env' } })!;
    expect(eventEnvelopeSchema.parse(event)).toBeTruthy();
    expect(event.payload).toMatchObject({ input: { path: 'D:/Work/Repo/.env' }, response: { success: true } });
    expect(JSON.stringify(event)).not.toContain('topsecret');
  });

  it('never records Edit strings', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'OLD-SECRET', new_string: 'NEW-SECRET' }, tool_response: {} })!;
    expect(JSON.stringify(event)).not.toMatch(/OLD-SECRET|NEW-SECRET/);
  });

  it('records a redacted command and output sizes, never the output', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer tok123456" https://x' }, tool_response: { stdout: 'PRIVATE OUTPUT', stderr: '', interrupted: false } })!;
    expect(event.payload).toMatchObject({ input: { command: expect.stringContaining('[REDACTED]') }, response: { stdoutLength: 14, stderrLength: 0, interrupted: false } });
    expect(event.redaction).toEqual({ applied: true, reasons: ['authorization-header'] });
    expect(JSON.stringify(event)).not.toMatch(/tok123456|PRIVATE OUTPUT/);
  });

  it('stores only the size and slash command of a prompt', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'UserPromptSubmit', prompt: '/jerry:task add a login form with my password hunter2' })!;
    expect(event.payload).toEqual({ promptLength: 53, slashCommand: '/jerry:task' });
    expect(JSON.stringify(event)).not.toContain('hunter2');
  });

  it('records MCP argument names but not their values', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 'Private title', body: 'private body' }, tool_response: 'ok' })!;
    expect(event.payload).toMatchObject({ input: { argumentKeys: ['title', 'body'] }, response: { responseLength: 2 } });
    expect(JSON.stringify(event)).not.toMatch(/Private title|private body/);
  });

  it('redacts and truncates tool failure messages', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'deploy' }, error: `failed with token=abc123def ${'x'.repeat(1000)}`, is_interrupt: false })!;
    const error = event.payload['error'] as string;
    expect(error).not.toContain('abc123def');
    expect(error.length).toBeLessThanOrEqual(301);
  });

  it('records subagent, stop and session-end metadata', () => {
    expect(buildEventEnvelope({ ...common, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'security-reviewer' })).toMatchObject({ agentId: 'a1', agentType: 'security-reviewer' });
    expect(buildEventEnvelope({ ...common, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'x', last_assistant_message: 'done here', stop_hook_active: false })!.payload).toEqual({ lastMessageLength: 9, stopHookActive: false });
    expect(buildEventEnvelope({ ...common, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })!.payload).toEqual({ reason: 'prompt_input_exit' });
  });

  it('ignores events JERRY does not record', () => {
    expect(buildEventEnvelope({ ...common, hook_event_name: 'Notification' })).toBeNull();
  });
});
