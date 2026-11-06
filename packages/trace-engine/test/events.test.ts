import { eventEnvelopeSchema } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { buildEventEnvelope } from '../src/events.js';
import { redactText } from '../src/redaction.js';

/**
 * Credential-shaped fixtures are assembled at runtime from fragments, so this file contains no
 * literal that secret scanners (GitGuardian, GitHub push protection) would report. Every value is
 * fake and exists only to exercise the redaction rules.
 */
const fake = (...parts: string[]): string => parts.join('');
const FAKE = {
  password: fake('not-a-real-', 'pass'),
  jwt: [fake('ey', 'JhbGciOiJIUzI1NiJ9'), fake('ey', 'JzdWIiOiJ0ZXN0In0'), fake('Zm9yLXRlc3Rz', 'LW9ubHk')].join('.'),
  githubToken: fake('gh', 'p_', 'TESTONLY', 'abcdefghijklmnopqrstuvwxyz0123'),
  apiKey: fake('s', 'k-', 'TESTONLY', 'abcdefghijklmnopqrstuvwxyz'),
  awsAccessKey: fake('AK', 'IA', 'TESTONLYTESTONLY'),
  bearer: fake('fake', 'bearer', '123456'),
  assigned: fake('fake', 'assigned', 'value'),
};

const common = { session_id: 's1', cwd: 'D:/Work/Repo', transcript_path: 'C:/t.jsonl' };

describe('redactText', () => {
  it.each([
    [`curl -H "Authorization: Bearer ${FAKE.bearer}" https://api`, 'authorization-header'],
    [`psql postgres://admin:${FAKE.password}@db:5432/app`, 'url-credentials'],
    [`export API_KEY=${FAKE.assigned}`, 'credential-assignment'],
    [`set DB_PASSWORD="${FAKE.password} with space"`, 'credential-assignment'],
    [`mysql -u root --password ${FAKE.password}`, 'credential-flag'],
    [`git clone https://${FAKE.githubToken}@github.com/x/y`, 'github-token'],
    [`ANTHROPIC=${FAKE.apiKey} node x`, 'api-key'],
    [`aws configure set aws_access_key_id ${FAKE.awsAccessKey}`, 'aws-access-key'],
    [`echo ${FAKE.jwt}`, 'jwt'],
    [`curl -b "Cookie: session=${FAKE.assigned}"`, 'cookie-header'],
  ])('masks %s', (input, reason) => {
    const result = redactText(input);
    expect(result.reasons).toContain(reason);
    expect(result.text).toContain('[REDACTED]');
  });

  it('leaves ordinary commands untouched', () => {
    expect(redactText('npm test -- --run src/app.test.ts')).toEqual({ text: 'npm test -- --run src/app.test.ts', reasons: [] });
  });

  it('never leaves the secret value in the text', () => {
    expect(redactText(`psql postgres://admin:${FAKE.password}@db/app`).text).not.toContain(FAKE.password);
    expect(redactText(`mysql --password=${FAKE.password}`).text).not.toContain(FAKE.password);
    expect(redactText(`echo ${FAKE.jwt}`).text).not.toContain(FAKE.jwt);
  });
});

describe('buildEventEnvelope: data minimization', () => {
  it('records the target path of a Write, never its content', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: 'D:/Work/Repo/.env', content: 'FILE-CONTENT-MARKER' }, tool_response: { success: true, filePath: 'D:/Work/Repo/.env' } })!;
    expect(eventEnvelopeSchema.parse(event)).toBeTruthy();
    expect(event.payload).toMatchObject({ input: { path: 'D:/Work/Repo/.env' }, response: { success: true } });
    expect(JSON.stringify(event)).not.toContain('FILE-CONTENT-MARKER');
  });

  it('never records Edit strings', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'OLD-TEXT-MARKER', new_string: 'NEW-TEXT-MARKER' }, tool_response: {} })!;
    expect(JSON.stringify(event)).not.toMatch(/OLD-TEXT-MARKER|NEW-TEXT-MARKER/);
  });

  it('records a redacted command and output sizes, never the output', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${FAKE.bearer}" https://x` }, tool_response: { stdout: 'PRIVATE OUTPUT', stderr: '', interrupted: false } })!;
    expect(event.payload).toMatchObject({ input: { command: expect.stringContaining('[REDACTED]') }, response: { stdoutLength: 14, stderrLength: 0, interrupted: false } });
    expect(event.redaction).toEqual({ applied: true, reasons: ['authorization-header'] });
    expect(JSON.stringify(event)).not.toContain(FAKE.bearer);
    expect(JSON.stringify(event)).not.toContain('PRIVATE OUTPUT');
  });

  it('stores only the size and slash command of a prompt', () => {
    const prompt = '/jerry:task add a login form, PROMPT-TEXT-MARKER';
    const event = buildEventEnvelope({ ...common, hook_event_name: 'UserPromptSubmit', prompt })!;
    expect(event.payload).toEqual({ promptLength: prompt.length, slashCommand: '/jerry:task' });
    expect(JSON.stringify(event)).not.toContain('PROMPT-TEXT-MARKER');
  });

  it('records MCP argument names but not their values', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 'Private title', body: 'private body' }, tool_response: 'ok' })!;
    expect(event.payload).toMatchObject({ input: { argumentKeys: ['title', 'body'] }, response: { responseLength: 2 } });
    expect(JSON.stringify(event)).not.toMatch(/Private title|private body/);
  });

  it('redacts and truncates tool failure messages', () => {
    const event = buildEventEnvelope({ ...common, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'deploy' }, error: `failed with token=${FAKE.assigned} ${'x'.repeat(1000)}`, is_interrupt: false })!;
    const error = event.payload['error'] as string;
    expect(error).not.toContain(FAKE.assigned);
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
