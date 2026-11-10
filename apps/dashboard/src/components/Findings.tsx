import type { Finding, FindingSeverity, TaskSummary } from '@jerry/contracts';
import { EMOJI, SEVERITY_EMOJI } from '@jerry/contracts/emoji';
import { computed, defineComponent, onMounted, ref, watch, type PropType } from 'vue';
import { api } from '../api';
import { formatTime } from '../format';
import { handleError, perform } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Section } from './Section';
import { StatusBadge, type Tone } from './StatusBadge';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Loading } from './ui/spinner';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

const SEVERITY_TONE: Record<FindingSeverity, Tone> = { P1: 'deny', P2: 'deny', P3: 'warn', P4: 'neutral' };
const SEVERITY_ORDER: Record<FindingSeverity, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
type Decision = 'OPEN' | 'ACCEPTED' | 'WONT_FIX' | 'FALSE_POSITIVE';
const DECISION_LABEL: Record<Decision, string> = { OPEN: 'Reopen', ACCEPTED: 'Accept', WONT_FIX: "Won't fix", FALSE_POSITIVE: 'False positive' };
const STATUS_LABEL: Record<Finding['status'], string> = { OPEN: 'open', ACCEPTED: 'accepted', FIXED: 'fixed', WONT_FIX: "won't fix", FALSE_POSITIVE: 'false positive' };
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;

/**
 * A task's quality findings: what JERRY found on the lines Claude changed. JERRY marks
 * findings FIXED itself; only the user accepts or dismisses one, with a reason.
 */
export const FindingsPanel = defineComponent({
  name: 'FindingsPanel',
  props: { task: { type: Object as PropType<TaskSummary>, required: true } },
  setup(props) {
    const findings = ref<Finding[] | null>(null);
    const showAll = ref(false);
    const severity = ref<'all' | FindingSeverity>('all');
    const pending = ref<{ finding: Finding; decision: Decision } | null>(null);
    const busy = ref(false);

    const load = async (): Promise<void> => {
      try {
        findings.value = await api.findings(props.task.taskId);
      } catch (error) {
        handleError(error);
      }
    };
    // Serious findings open the panel by themselves, so they load at once.
    onMounted(() => {
      const counts = props.task.findings;
      if (counts !== null && counts.bySeverity.P1 + counts.bySeverity.P2 > 0) void load();
    });
    // Reload when the counts change (a check ran or a decision was taken).
    watch(
      () => JSON.stringify(props.task.findings),
      () => {
        if (findings.value !== null) void load();
      },
    );

    const shown = computed(() =>
      (findings.value ?? [])
        .filter((finding) => showAll.value || finding.status === 'OPEN' || finding.status === 'ACCEPTED')
        .filter((finding) => severity.value === 'all' || finding.severity === severity.value)
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.lineStart - b.lineStart),
    );

    const decide = async (_typed: string, reason: string): Promise<void> => {
      const current = pending.value;
      if (current === null) return;
      busy.value = true;
      const done = await perform(() => api.setFindingStatus(current.finding.findingId, current.decision, reason), `${current.finding.findingId}: ${DECISION_LABEL[current.decision].toLowerCase()}.`);
      busy.value = false;
      if (done) {
        pending.value = null;
        await load();
      }
    };

    const actions = (finding: Finding) => {
      const decisions: Decision[] = finding.status === 'OPEN' ? ['ACCEPTED', 'WONT_FIX', 'FALSE_POSITIVE'] : finding.status === 'ACCEPTED' ? ['WONT_FIX', 'FALSE_POSITIVE'] : finding.status === 'FIXED' ? [] : ['OPEN'];
      return decisions.map((decision) => (
        <Button key={decision} type="button" variant="ghost" size="xs" onClick={() => (pending.value = { finding, decision })}>
          {DECISION_LABEL[decision]}
        </Button>
      ));
    };

    return () => {
      const counts = props.task.findings;
      if (counts === null) return null;
      const serious = counts.bySeverity.P1 + counts.bySeverity.P2;
      const switchId = `findings-all-${props.task.taskId}`;
      return (
        <Section class="findings" emoji={EMOJI.finding} defaultOpen={serious > 0} onToggle={(open: boolean) => open && findings.value === null && void load()}>
          {{
            title: () => [
              'Quality findings ',
              <StatusBadge tone={serious > 0 ? 'deny' : counts.open > 0 ? 'warn' : 'pass'}>{counts.open} open</StatusBadge>,
              <span class="text-muted-foreground text-xs font-normal">
                {SEVERITIES.filter((level) => counts.bySeverity[level] > 0)
                  .map((level) => `${counts.bySeverity[level]} ${level}`)
                  .join(' · ')}
                {counts.fixed > 0 && ` · ${counts.fixed} fixed`}
                {counts.dismissed > 0 && ` · ${counts.dismissed} dismissed`}
              </span>,
            ],
            default: () => (
              <div class="grid gap-3">
                <div class="findings__filters flex flex-wrap items-center gap-4">
                  <div class="flex items-center gap-2">
                    <Switch id={switchId} modelValue={showAll.value} onUpdate:modelValue={(value: boolean) => (showAll.value = value)} />
                    <Label for={switchId}>Show fixed and dismissed</Label>
                  </div>
                  <Tabs modelValue={severity.value} onUpdate:modelValue={(value: string) => (severity.value = value as 'all' | FindingSeverity)}>
                    <TabsList aria-label="Severity" class="h-8">
                      <TabsTrigger value="all">all</TabsTrigger>
                      {SEVERITIES.map((level) => (
                        <TabsTrigger key={level} value={level}>
                          {level}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
                {findings.value === null && <Loading class="text-xs" text="Loading findings…" />}
                {findings.value !== null && shown.value.length === 0 && <p class="text-muted-foreground">Nothing to show with these filters.</p>}
                <ul class="divide-y">
                  {shown.value.map((finding) => (
                    <li key={finding.findingId} data-status={finding.status} class={['grid gap-1.5 py-3', finding.status !== 'OPEN' && finding.status !== 'ACCEPTED' && 'opacity-70']}>
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <StatusBadge tone={SEVERITY_TONE[finding.severity]} emoji={SEVERITY_EMOJI[finding.severity]}>
                          {finding.severity}
                        </StatusBadge>{' '}
                        <strong class="font-medium">{finding.title}</strong>{' '}
                        <code class="font-mono text-xs">
                          {finding.file}:{finding.lineStart}
                        </code>{' '}
                        <span class="text-muted-foreground text-xs">
                          {finding.findingId} · {STATUS_LABEL[finding.status]} · {finding.ruleId} · seen {formatTime(finding.lastSeenAt)}
                        </span>
                      </div>
                      <pre class="bg-muted overflow-x-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap">{finding.evidence}</pre>
                      <p class="text-sm">
                        {finding.whyItMatters} <span class="text-muted-foreground">Fix: {finding.suggestedFix}</span>
                      </p>
                      {finding.statusReason !== '' && <p class="text-muted-foreground text-xs">Reason: {finding.statusReason}</p>}
                      <div class="flex flex-wrap gap-1">{actions(finding)}</div>
                    </li>
                  ))}
                </ul>
                {pending.value !== null && (
                  <ConfirmDialog
                    title={`${DECISION_LABEL[pending.value.decision]}: ${pending.value.finding.findingId}`}
                    expected={pending.value.finding.findingId}
                    confirmLabel={DECISION_LABEL[pending.value.decision]}
                    busy={busy.value}
                    commentLabel="Reason (required)"
                    commentRequired
                    onConfirm={decide}
                    onCancel={() => (pending.value = null)}
                  >
                    <p class="text-foreground">{pending.value.finding.title}</p>
                    <p>
                      {pending.value.finding.file}:{pending.value.finding.lineStart} · {pending.value.finding.evidence}
                    </p>
                    {pending.value.decision === 'FALSE_POSITIVE' && <p class="text-xs">False positives calibrate the rule: after three, JERRY stops applying it.</p>}
                  </ConfirmDialog>
                )}
              </div>
            ),
          }}
        </Section>
      );
    };
  },
});
