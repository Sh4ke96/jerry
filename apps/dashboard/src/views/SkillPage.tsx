import type { SkillDetail } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api, HttpError } from '../api';
import { Emoji } from '../components/Emoji';
import { SkillScan, SkillStates, useSkillActions } from '../components/SkillActions';
import { StatusBadge } from '../components/StatusBadge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { formatBytes, formatTime } from '../format';
import { CHIP } from '../lib/classes';
import { navigate } from '../router';
import { handleError } from '../state';
import { addedTile } from './Skills';

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
            <ul class="grid">{addedTile(skill, actions)}</ul>
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
          {skill.kind === 'added' && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.jerry} />
                  When JERRY starts it
                </CardTitle>
                <CardDescription>
                  Only JERRY starts this skill. While a task is in one of these states, JERRY tells Claude to use it; you cannot start it with / and Claude does not pick it on its own. Using it in another state is recorded as a deviation.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SkillStates skill={skill} onSaved={load} />
              </CardContent>
            </Card>
          )}
          {skill.kind === 'added' && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.security} />
                  Scan
                </CardTitle>
                <CardDescription>What JERRY found when the installed version was previewed.</CardDescription>
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
