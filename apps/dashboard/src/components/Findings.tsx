import type { Finding, FindingSeverity, TaskSummary } from '@jerry/contracts';
import { computed, defineComponent, onMounted, ref, watch, type PropType } from 'vue';
import { api } from '../api';
import { formatTime } from '../format';
import { handleError, perform } from '../state';
import { Badge, type Tone } from './Badge';
import { ConfirmDialog } from './ConfirmDialog';

const SEVERITY_TONE: Record<FindingSeverity, Tone> = { P1: 'deny', P2: 'deny', P3: 'warn', P4: 'neutral' };
const SEVERITY_ORDER: Record<FindingSeverity, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
type Decision = 'OPEN' | 'ACCEPTED' | 'WONT_FIX' | 'FALSE_POSITIVE';
const DECISION_LABEL: Record<Decision, string> = { OPEN: 'Reopen', ACCEPTED: 'Accept', WONT_FIX: "Won't fix", FALSE_POSITIVE: 'False positive' };
const STATUS_LABEL: Record<Finding['status'], string> = { OPEN: 'open', ACCEPTED: 'accepted', FIXED: 'fixed', WONT_FIX: "won't fix", FALSE_POSITIVE: 'false positive' };

/**
 * A task's quality findings (ADR 0027): what JERRY found on the lines Claude changed. JERRY marks
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
        <button key={decision} type="button" class="button button--quiet button--small" onClick={() => (pending.value = { finding, decision })}>
          {DECISION_LABEL[decision]}
        </button>
      ));
    };

    return () => {
      const counts = props.task.findings;
      if (counts === null) return null;
      const serious = counts.bySeverity.P1 + counts.bySeverity.P2;
      return (
        <details class="plan-section findings" open={serious > 0} onToggle={(event: Event) => (event.target as HTMLDetailsElement).open && findings.value === null && void load()}>
          <summary>
            Quality findings{' '}
            <Badge tone={serious > 0 ? 'deny' : counts.open > 0 ? 'warn' : 'pass'}>{counts.open} open</Badge>{' '}
            <span class="muted small">
              {(['P1', 'P2', 'P3', 'P4'] as const)
                .filter((level) => counts.bySeverity[level] > 0)
                .map((level) => `${counts.bySeverity[level]} ${level}`)
                .join(' · ')}
              {counts.fixed > 0 && ` · ${counts.fixed} fixed`}
              {counts.dismissed > 0 && ` · ${counts.dismissed} dismissed`}
            </span>
          </summary>
          <div class="plan-section__body">
            <div class="findings__filters">
              <label>
                <input type="checkbox" checked={showAll.value} onChange={(event: Event) => (showAll.value = (event.target as HTMLInputElement).checked)} /> Show fixed and dismissed
              </label>
              <label>
                Severity{' '}
                <select value={severity.value} onChange={(event: Event) => (severity.value = (event.target as HTMLSelectElement).value as 'all' | FindingSeverity)}>
                  <option value="all">all</option>
                  {(['P1', 'P2', 'P3', 'P4'] as const).map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {findings.value === null && <p class="muted small">Loading findings…</p>}
            {findings.value !== null && shown.value.length === 0 && <p class="muted">Nothing to show with these filters.</p>}
            <ul class="findings__list">
              {shown.value.map((finding) => (
                <li key={finding.findingId} class={['finding', `finding--${finding.status.toLowerCase()}`]}>
                  <div class="finding__head">
                    <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge> <strong>{finding.title}</strong>{' '}
                    <code>
                      {finding.file}:{finding.lineStart}
                    </code>{' '}
                    <span class="muted small">
                      {finding.findingId} · {STATUS_LABEL[finding.status]} · {finding.ruleId} · seen {formatTime(finding.lastSeenAt)}
                    </span>
                  </div>
                  <pre class="finding__evidence">{finding.evidence}</pre>
                  <p class="small">
                    {finding.whyItMatters} <span class="muted">Fix: {finding.suggestedFix}</span>
                  </p>
                  {finding.statusReason !== '' && <p class="muted small">Reason: {finding.statusReason}</p>}
                  <div class="actions">{actions(finding)}</div>
                </li>
              ))}
            </ul>
          </div>
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
              <p>{pending.value.finding.title}</p>
              <p class="muted">
                {pending.value.finding.file}:{pending.value.finding.lineStart} · {pending.value.finding.evidence}
              </p>
              {pending.value.decision === 'FALSE_POSITIVE' && <p class="muted small">False positives calibrate the rule: after three, JERRY stops applying it.</p>}
            </ConfirmDialog>
          )}
        </details>
      );
    };
  },
});
