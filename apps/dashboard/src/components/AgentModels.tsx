import type { AgentModelEntry, AgentModelsResponse } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { computed, defineComponent, onMounted, ref, type PropType } from 'vue';
import { api, HttpError } from '../api';
import { Emoji } from './Emoji';
import { StatusBadge } from './StatusBadge';
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';

/** The JERRY skills that start read-only subagents, and the phase of those subagents. */
export const SKILL_AGENT_PHASE: Readonly<Record<string, 'analysis' | 'review'>> = { 'jerry:analyze': 'analysis', 'jerry:review': 'review' };

const MODEL_LABEL: Record<AgentModelEntry['model'], string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  inherit: 'Session model',
};
const EFFORT_LABEL: Record<AgentModelEntry['effort'], string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', default: 'Session effort' };
/** What each subagent does, in a few words. */
const ROLE_LABEL: Record<string, string> = {
  'jerry-architecture-analyst': 'Architecture analyst',
  'jerry-risk-analyst': 'Risk analyst',
  'jerry-quality-analyst': 'Quality analyst',
  'jerry-correctness-reviewer': 'Correctness reviewer',
  'jerry-security-reviewer': 'Security reviewer',
  'jerry-design-reviewer': 'Design reviewer',
};

const SELECT = 'border-input bg-background hover:bg-accent/40 h-9 rounded-md border px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The model and reasoning effort of the read-only subagents a JERRY skill starts. Saved at once:
 * Core stores the choice and writes it into the installed plugin's agent files, which Claude Code
 * reads when it starts a subagent.
 */
export const AgentModels = defineComponent({
  name: 'AgentModels',
  props: { phase: { type: String as PropType<'analysis' | 'review'>, required: true } },
  setup(props) {
    const agents = ref<AgentModelEntry[] | null>(null);
    const unavailable = ref(false);
    const saving = ref<string | null>(null);
    const message = ref<{ text: string; error: boolean } | null>(null);

    const apply = (answer: AgentModelsResponse): void => {
      agents.value = answer.agents;
      message.value = answer.problems.length > 0 ? { text: answer.problems.join(' '), error: true } : null;
    };
    onMounted(async () => {
      try {
        apply(await api.agentModels());
      } catch (error) {
        // An older Core has no such route: the card says so instead of failing the page.
        if (error instanceof HttpError && error.status === 404) unavailable.value = true;
        else message.value = { text: (error as Error).message, error: true };
      }
    });

    const shown = computed(() => (agents.value ?? []).filter((agent) => agent.phase === props.phase));

    const save = async (agent: AgentModelEntry, change: Partial<Pick<AgentModelEntry, 'model' | 'effort'>>): Promise<void> => {
      if (saving.value !== null) return;
      saving.value = agent.role;
      try {
        const answer = await api.saveAgentModels([{ role: agent.role, model: change.model ?? agent.model, effort: change.effort ?? agent.effort }]);
        apply(answer);
        if (answer.problems.length === 0) message.value = { text: `Saved. New Claude Code sessions use it; in an open one, run /reload-plugins or restart it.`, error: false };
      } catch (error) {
        message.value = { text: (error as Error).message, error: true };
      } finally {
        saving.value = null;
      }
    };

    const row = (agent: AgentModelEntry) => {
      const isDefault = agent.model === agent.defaults.model && agent.effort === agent.defaults.effort;
      const busy = saving.value !== null;
      return (
        <li key={agent.role} class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-agent-model={agent.role}>
          <div class="grid gap-0.5">
            <span class="flex items-center gap-2 text-sm font-medium">
              {ROLE_LABEL[agent.role] ?? agent.role}
              {isDefault ? <StatusBadge>default</StatusBadge> : <StatusBadge tone="pass">your choice</StatusBadge>}
            </span>
            <span class="text-muted-foreground font-mono text-xs">
              jerry:{agent.role} · default {MODEL_LABEL[agent.defaults.model]}, {EFFORT_LABEL[agent.defaults.effort].toLowerCase()}
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Label class="sr-only" for={`model-${agent.role}`}>
              Model of {ROLE_LABEL[agent.role] ?? agent.role}
            </Label>
            <select id={`model-${agent.role}`} class={SELECT} data-agent-field="model" value={agent.model} disabled={busy} onChange={(event: Event) => void save(agent, { model: (event.target as HTMLSelectElement).value as AgentModelEntry['model'] })}>
              {Object.entries(MODEL_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Label class="sr-only" for={`effort-${agent.role}`}>
              Reasoning effort of {ROLE_LABEL[agent.role] ?? agent.role}
            </Label>
            <select id={`effort-${agent.role}`} class={SELECT} data-agent-field="effort" value={agent.effort} disabled={busy} onChange={(event: Event) => void save(agent, { effort: (event.target as HTMLSelectElement).value as AgentModelEntry['effort'] })}>
              {Object.entries(EFFORT_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </li>
      );
    };

    return () => (
      <Card class="agent-models">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.jerry} />
            Subagents
          </CardTitle>
          <CardDescription>
            The model and reasoning effort of each read-only {props.phase === 'analysis' ? 'analyst' : 'reviewer'} this skill starts. A smaller model or a lower effort uses fewer tokens; the session's settings apply to everything else. Saved as
            soon as you change it.
          </CardDescription>
        </CardHeader>
        <CardContent class="grid gap-4">
          {unavailable.value ? (
            <p class="text-muted-foreground text-sm">This JERRY Core does not offer model choices yet; update JERRY.</p>
          ) : agents.value === null && message.value === null ? (
            <p class="text-muted-foreground text-sm">Loading…</p>
          ) : (
            <ul class="grid gap-3">{shown.value.map(row)}</ul>
          )}
          {message.value !== null && (
            <Alert variant={message.value.error ? 'destructive' : 'default'} data-agent-models-message>
              <AlertDescription>{message.value.text}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  },
});
