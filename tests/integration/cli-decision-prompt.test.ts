import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDecision, type DecisionConfirmation } from '../../apps/cli/src/settings-commands.js';

/**
 * The CLI's destructive prompts (cancel a task, approve, add or remove a project, delete or forget
 * data, install or remove a skill) follow the decision confirmation setting like the dashboard:
 * typed asks for the ID, path, name or word; click asks y/N.
 */
describe('CLI decision prompt', () => {
  const prompt = { question: 'Cancel JRY-0004?', typedPrompt: 'Type JRY-0004 to cancel it', matches: (typed: string) => typed.trim() === 'JRY-0004' };
  const io = (mode: DecisionConfirmation, answer: string) => {
    const asked: string[] = [];
    return {
      asked,
      io: {
        decisionConfirmation: async () => mode,
        ask: async (question: string) => {
          asked.push(question);
          return answer;
        },
      },
    };
  };
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('asks y/N in one-click mode, without typing the ID', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const yes = io('click', 'y');
    expect(await confirmDecision(prompt, yes.io)).toBe(true);
    expect(yes.asked).toEqual(['Cancel JRY-0004? [y/N] ']);
    const no = io('click', '');
    expect(await confirmDecision(prompt, no.io)).toBe(false);
    // Saying no is not an error.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('asks for the typed ID when the user chose typed confirmations', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const right = io('typed', ' JRY-0004 ');
    expect(await confirmDecision(prompt, right.io)).toBe(true);
    expect(right.asked).toEqual(['Type JRY-0004 to cancel it: ']);
    const wrong = io('typed', 'y');
    expect(await confirmDecision(prompt, wrong.io)).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
