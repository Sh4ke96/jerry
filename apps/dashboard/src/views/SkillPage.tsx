import type { SkillDetail } from '@jerry/contracts';
import { SKILL_MODEL_ROLES } from '@jerry/contracts/agents';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api, HttpError } from '../api';
import { AgentModels, SKILL_AGENT_PHASE } from '../components/AgentModels';
import { Emoji } from '../components/Emoji';
import { SkillScan, SkillStates, useSkillActions } from '../components/SkillActions';
import { StatusBadge } from '../components/StatusBadge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { formatBytes, formatTime } from '../format';
import { CHIP } from '../lib/classes';
import { projectName } from '../lib/tasks';
import { linkTo, navigate, taskHref } from '../router';
import { handleError } from '../state';
import { addedTile } from './Skills';

/** The skill's page: what it is and when JERRY starts it, its uses, the scan, SKILL.md, files and history. */
const ACTION_LABEL: Record<string, string> = { installed: 'Installed', updated: 'Updated', enabled: 'Switched on', disabled: 'Switched off', removed: 'Removed', 'states-set': 'Task states changed' };

/** One skill: SKILL.md, its files, the scan and what happened to it. */
export const SkillPage = defineComponent({
  name: 'SkillPage',
  props: { name: { type: String, required: true } },
  setup(props) {
    const detail = ref<SkillDetail | null>(null);
    const missing = ref(false);
    const load = async (): Promise<void> => {
      try {
        detail.value = await api.skill(props.name);
      } catch (error) {
        // Removed: back to the list.
        if (error instanceof HttpError && error.status === 404) {
          if (detail.value !== null) navigate({ section: 'skills' });
          missing.value = true;
          return;
        }
        handleError(error);
      }
    };
    const actions = useSkillActions(load);
    onMounted(() => void load());

    return () => {
      if (missing.value) return <p class="skill-page text-muted-foreground text-sm">There is no skill named {props.name}.</p>;
      const current = detail.value;
      if (current === null) return <p class="skill-page text-muted-foreground text-sm">Loading…</p>;
      const { skill } = current;
      return (
        <div class="skill-page flex flex-col gap-4 md:gap-6" data-skill-page={skill.name}>
          {skill.kind === 'added' ? (
            <ul class="grid">{addedTile(skill, actions, { onPage: true })}</ul>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  {skill.name}
                  <StatusBadge>read-only</StatusBadge>
                </CardTitle>
                <CardDescription>
                  {skill.description} {skill.kind === 'jerry' ? 'Part of JERRY’s plugin.' : 'Not installed by JERRY; JERRY leaves it alone.'} <code class={CHIP}>{skill.dir}</code>
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          {skill.kind === 'jerry' && SKILL_AGENT_PHASE[skill.name] !== undefined && <AgentModels phase={SKILL_AGENT_PHASE[skill.name]!} />}
          {skill.kind === 'jerry' && SKILL_MODEL_ROLES.some((role) => role.id === skill.name) && <AgentModels role={skill.name} />}
          {skill.kind === 'added' && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.jerry} />
                  When JERRY starts it
                </CardTitle>
                <CardDescription>
                  Only JERRY starts this skill: when a task enters one of these states, JERRY's next step for Claude names the skill and Claude runs it. You cannot start it with / and Claude does not pick it on its own; a use in
                  another state is recorded as a deviation.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SkillStates skill={skill} onSaved={load} />
              </CardContent>
            </Card>
          )}
          <Card class="skill-uses">
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.session} />
                Recent uses
              </CardTitle>
              <CardDescription>Each time Claude ran this skill, as JERRY saw it (newest first).</CardDescription>
            </CardHeader>
            <CardContent>
              {current.uses.length === 0 ? (
                <p class="text-muted-foreground text-sm">Not used yet. Uses are recorded from this JERRY version on.</p>
              ) : (
                <ul class="grid gap-1.5 text-sm">
                  {current.uses.map((use, index) => (
                    <li key={index} class="flex flex-wrap items-center gap-x-2 gap-y-1" data-skill-use={use.verdict ?? 'unknown'}>
                      <span class="text-muted-foreground tabular-nums">{formatTime(use.at)}</span>
                      {use.taskId !== null ? (
                        <a class="font-mono hover:underline" {...linkTo(taskHref(use.taskId))}>
                          {use.taskId}
                        </a>
                      ) : (
                        <span class="text-muted-foreground">no task</span>
                      )}
                      {use.verdict === 'WARN' ? (
                        <StatusBadge tone="warn" emoji={EMOJI.warning} title={use.ruleId ?? undefined}>
                          outside its states (deviation)
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="pass" emoji={EMOJI.pass} title={use.ruleId ?? undefined}>
                          {use.ruleId === 'monitor.skill-in-state' ? 'started by JERRY' : 'used'}
                        </StatusBadge>
                      )}
                      {use.repoRoot !== null && <span class="text-muted-foreground text-xs">{projectName(use.repoRoot)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {skill.kind === 'added' && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.security} />
                  Scan
                </CardTitle>
                <CardDescription>What JERRY found when the installed version was previewed.</CardDescription>
                <div class="skill-scan-summary flex flex-wrap gap-2 pt-1 text-xs">
                  {skill.scan.dangers > 0 && (
                    <StatusBadge tone="deny" emoji={EMOJI.blocked}>
                      {skill.scan.dangers} red
                    </StatusBadge>
                  )}
                  {skill.scan.warnings > 0 && (
                    <StatusBadge tone="warn" emoji={EMOJI.warning}>
                      {skill.scan.warnings} amber
                    </StatusBadge>
                  )}
                  {skill.scan.dangers === 0 && skill.scan.warnings === 0 && <StatusBadge tone="pass">nothing to point out</StatusBadge>}
                </div>
              </CardHeader>
              <CardContent>
                <SkillScan findings={current.scan} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.report} />
                SKILL.md
              </CardTitle>
            </CardHeader>
            <CardContent>
              {current.skillMd === null ? <p class="text-muted-foreground text-sm">The folder has no SKILL.md any more.</p> : <pre class="skill-md bg-muted max-h-[32rem] overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">{current.skillMd}</pre>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.repository} />
                Files
              </CardTitle>
              <CardDescription>{current.files.length} file(s)</CardDescription>
            </CardHeader>
            <CardContent>
              <ul class="skill-files grid gap-0.5">
                {current.files.map((file) => (
                  <li key={file.path} class="flex justify-between gap-3 font-mono text-xs">
                    <span class="break-all">{file.path}</span>
                    <span class="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {current.history.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.checkpoint} />
                  History
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul class="skill-history grid gap-1 text-sm">
                  {current.history.map((event, index) => (
                    <li key={index}>
                      {formatTime(event.at)} · {ACTION_LABEL[event.action] ?? event.action} ({event.channel === 'dashboard' ? 'in the dashboard' : 'in a terminal'})
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {actions.dialogs()}
        </div>
      );
    };
  },
});
