import type { AgentRun, AnalysisReportRecord } from '@jerry/contracts';
import { defineComponent, type PropType } from 'vue';
import { formatTime } from '../format';
import { Badge, type Tone } from './Badge';

const ROLE_LABEL: Record<string, string> = {
  'jerry-architecture-analyst': 'Architecture and contracts',
  'jerry-risk-analyst': 'Risk',
  'jerry-quality-analyst': 'Quality',
};
const CONFIDENCE_TONE: Record<string, Tone> = { low: 'warn', medium: 'neutral', high: 'pass' };
const SEVERITY_TONE: Record<string, Tone> = { low: 'neutral', medium: 'warn', high: 'deny', critical: 'deny' };

/** The analysts' reports (ADR 0023) with Core's citation check, and runs that left a gap. */
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
        <details class="plan-section analysis" open>
          <summary>Analysis ({props.analyses.length} report(s))</summary>
          <div class="plan-section__body">
            {gaps.map((run) => (
              <p key={run.agentId} class="attention">
                {run.agentType ?? run.agentId}: {run.status === 'no-report' ? 'stopped without a report' : 'no result after 30 minutes'} (a gap, not a result)
              </p>
            ))}
            {props.analyses.map((analysis) => {
              const { report, citations } = analysis;
              const problems = [...citations.missingFiles.map((file) => `${file} (missing)`), ...citations.outOfRange.map((entry) => `${entry} (beyond end of file)`)];
              return (
                <section key={analysis.id} class="analysis__report">
                  <h4>
                    {ROLE_LABEL[report.role] ?? report.role} <Badge tone={CONFIDENCE_TONE[report.confidence.level] ?? 'neutral'}>{report.confidence.level} confidence</Badge>{' '}
                    <span class="muted small">
                      #{analysis.id} · {formatTime(analysis.createdAt)}
                    </span>
                  </h4>
                  <p class="muted small">
                    {report.filesRead.length} file(s) read · citations {citations.checked - problems.length}/{citations.checked} verified
                  </p>
                  {problems.length > 0 && <p class="attention small">Unverified citations: {problems.join(', ')}</p>}
                  <ul class="list">
                    {report.observations.map((observation, index) => (
                      <li key={`o${index}`}>
                        {observation.statement} <span class="muted small">{observation.evidence.join(', ')}</span>
                      </li>
                    ))}
                    {report.risks.map((risk, index) => (
                      <li key={`r${index}`}>
                        <Badge tone={SEVERITY_TONE[risk.severity] ?? 'neutral'}>{risk.severity}</Badge> {risk.risk}
                      </li>
                    ))}
                  </ul>
                  {report.gaps.length > 0 && <p class="muted small">Gaps: {report.gaps.join('; ')}</p>}
                </section>
              );
            })}
          </div>
        </details>
      );
    };
  },
});
