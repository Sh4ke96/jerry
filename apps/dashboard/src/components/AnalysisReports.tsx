import type { AgentRun, AnalysisReportRecord } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { formatTime } from '../format';
import { ATTENTION, LIST } from '../lib/classes';
import { Emoji } from './Emoji';
import { Section } from './Section';
import { StatusBadge, type Tone } from './StatusBadge';

const ROLE_LABEL: Record<string, string> = {
  'jerry-architecture-analyst': 'Architecture and contracts',
  'jerry-risk-analyst': 'Risk',
  'jerry-quality-analyst': 'Quality',
};
const CONFIDENCE_TONE: Record<string, Tone> = { low: 'warn', medium: 'neutral', high: 'pass' };
const SEVERITY_TONE: Record<string, Tone> = { low: 'neutral', medium: 'warn', high: 'deny', critical: 'deny' };

/** The analysts' reports with Core's citation check, and runs that left a gap. */
export const AnalysisReports = defineComponent({
  name: 'AnalysisReports',
  props: {
    analyses: { type: Array as PropType<AnalysisReportRecord[]>, required: true },
    runs: { type: Array as PropType<AgentRun[]>, required: true },
  },
  setup(props) {
    return () => {
      const gaps = props.runs.filter((run) => run.status === 'no-report' || run.status === 'timed-out');
      if (props.analyses.length === 0 && gaps.length === 0) return null;
      return (
        <Section class="analysis" title={`Analysis (${props.analyses.length} report(s))`} emoji={EMOJI.analysis} defaultOpen>
          <div class="grid gap-4">
            {gaps.map((run) => (
              <p key={run.agentId} class={ATTENTION}>
                <Emoji symbol={EMOJI.warning} />
                {run.agentType ?? run.agentId}: {run.status === 'no-report' ? 'stopped without a report' : 'no result after 30 minutes'} (a gap, not a result)
              </p>
            ))}
            {props.analyses.map((analysis) => {
              const { report, citations } = analysis;
              const problems = [...citations.missingFiles.map((file) => `${file} (missing)`), ...citations.outOfRange.map((entry) => `${entry} (beyond end of file)`)];
              return (
                <section key={analysis.id} class="grid gap-2 rounded-lg border p-4">
                  <h4 class="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    <Emoji symbol={EMOJI.agent} class="mr-0" />
                    {ROLE_LABEL[report.role] ?? report.role} <StatusBadge tone={CONFIDENCE_TONE[report.confidence.level] ?? 'neutral'}>{report.confidence.level} confidence</StatusBadge>{' '}
                    <span class="text-muted-foreground text-xs font-normal">
                      #{analysis.id} · {formatTime(analysis.createdAt)}
                    </span>
                  </h4>
                  <p class="text-muted-foreground text-xs">
                    {report.filesRead.length} file(s) read · citations {citations.checked - problems.length}/{citations.checked} verified
                  </p>
                  {problems.length > 0 && (
                    <p class={[ATTENTION, 'text-xs']}>
                      <Emoji symbol={EMOJI.warning} />
                      Unverified citations: {problems.join(', ')}
                    </p>
                  )}
                  <ul class={LIST}>
                    {report.observations.map((observation, index) => (
                      <li key={`o${index}`}>
                        {observation.statement} <span class="text-muted-foreground font-mono text-xs">{observation.evidence.join(', ')}</span>
                      </li>
                    ))}
                    {report.risks.map((risk, index) => (
                      <li key={`r${index}`}>
                        <StatusBadge tone={SEVERITY_TONE[risk.severity] ?? 'neutral'}>{risk.severity}</StatusBadge> {risk.risk}
                      </li>
                    ))}
                  </ul>
                  {report.gaps.length > 0 && <p class="text-muted-foreground text-xs">Gaps: {report.gaps.join('; ')}</p>}
                </section>
              );
            })}
          </div>
        </Section>
      );
    };
  },
});
