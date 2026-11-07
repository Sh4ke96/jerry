import type { AddedSkill, OtherSkill, SkillsList } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Plus, RefreshCw, Trash2 } from '@lucide/vue';
import { defineComponent, onMounted, ref } from 'vue';
import { api } from '../api';
import { Emoji } from '../components/Emoji';
import { SKILL_NOTE, triggerText, useSkillActions } from '../components/SkillActions';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import { formatTime } from '../format';
import { CHIP } from '../lib/classes';
import { linkTo, navigate, skillHref } from '../router';
import { handleError } from '../state';

/** Where a skill came from, in one line. */
export function sourceLine(skill: AddedSkill): string {
  const { source } = skill;
  if (source.kind === 'github') return `GitHub ${source.source.replace(/^https:\/\/github\.com\//, '')}${source.commit === null ? '' : ` @ ${source.commit.slice(0, 7)}`}`;
  return `${source.kind === 'zip' ? 'zip' : 'folder'} ${source.source}`;
}

/** Clicks on these do their own thing; elsewhere on a row a click opens the skill's page. */
const INTERACTIVE = 'a, button, input, label, [role="switch"]';

/** Opens a skill's page from a click on its row (not on its controls). */
function openSkill(event: MouseEvent, name: string): void {
  if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
  navigate(skillHref(name));
}

/**
 * A skill added through JERRY as a full-width row: what it is, when JERRY starts it, the switch,
 * update and remove. The scan and everything else is on the skill's page (a click on the row).
 */
export function addedTile(skill: AddedSkill, actions: ReturnType<typeof useSkillActions>, options: { onPage?: boolean } = {}) {
  const switchId = `skill-enabled-${skill.name}`;
  return (
    <li key={skill.name} class={['skill-tile bg-card grid gap-3 rounded-xl border p-4', options.onPage !== true && 'cursor-pointer transition-shadow hover:shadow-md']} data-skill={skill.name} onClick={options.onPage === true ? undefined : (event: MouseEvent) => openSkill(event, skill.name)}>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="grid min-w-0 flex-1 gap-1">
          <a class="font-semibold hover:underline" {...linkTo(skillHref(skill.name))}>
            {skill.name}
          </a>
          <p class={['text-muted-foreground text-sm', options.onPage !== true && 'line-clamp-2']}>{skill.description}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <label for={switchId} class="text-muted-foreground text-xs">
            {skill.enabled ? 'On' : 'Off'}
          </label>
          <Switch id={switchId} aria-label={`${skill.name} on`} modelValue={skill.enabled} disabled={!skill.present || actions.busy.value} onUpdate:modelValue={(value: boolean) => actions.toggle(skill.name, value)} />
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span class="skill-trigger text-muted-foreground" data-trigger={!skill.jerryTriggered ? 'claude' : skill.states.length === 0 ? 'none' : 'jerry'}>
          <Emoji symbol={EMOJI.jerry} />
          {triggerText(skill)}
        </span>
        {!skill.present && <StatusBadge tone="deny">folder missing</StatusBadge>}
        {skill.modified && <StatusBadge tone="warn" title="The files differ from what JERRY installed">changed by hand</StatusBadge>}
        <span class="text-muted-foreground break-all">
          {sourceLine(skill)} · {skill.fileCount} file(s) · updated {formatTime(skill.updatedAt)}
        </span>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={actions.busy.value} data-skill-update onClick={() => actions.checkUpdate(skill.name, skill.source.kind === 'zip' && !/^([A-Za-z]:[\\/]|\/)/.test(skill.source.source))}>
          <RefreshCw />
          Update
        </Button>
        <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" disabled={actions.busy.value} data-skill-remove onClick={() => actions.askRemove(skill.name)}>
          <Trash2 />
          Remove
        </Button>
      </div>
    </li>
  );
}

/** A skill JERRY did not install, as a full-width row: its own (read-only) or the user's. */
function otherTile(skill: OtherSkill) {
  return (
    <li key={skill.name} class="skill-tile grid cursor-pointer gap-1 rounded-xl border p-4 transition-shadow hover:shadow-md" data-skill={skill.name} data-kind={skill.kind} onClick={(event: MouseEvent) => openSkill(event, skill.name)}>
      <div class="flex items-center justify-between gap-2">
        <a class="font-medium hover:underline" {...linkTo(skillHref(skill.name))}>
          {skill.name}
        </a>
        <StatusBadge tone="neutral" title={skill.kind === 'jerry' ? "Part of JERRY's plugin; it changes with JERRY" : 'Not installed by JERRY; JERRY leaves it alone'}>
          read-only
        </StatusBadge>
      </div>
      <p class="text-muted-foreground line-clamp-2 text-sm">{skill.description}</p>
    </li>
  );
}

/** Claude Code skills: the ones added through JERRY as tiles, JERRY's own and the user's other ones read-only. */
export const Skills = defineComponent({
  name: 'Skills',
  setup() {
    const list = ref<SkillsList | null>(null);
    const load = async (): Promise<void> => {
      try {
        list.value = await api.skills();
      } catch (error) {
        handleError(error);
      }
    };
    const actions = useSkillActions(load);
    onMounted(() => void load());

    return () => {
      const current = list.value;
      return (
        <div class="skills flex flex-col gap-4 md:gap-6">
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.implementation} />
                Added skills
              </CardTitle>
              <CardDescription>
                Skills you added through JERRY, in {current === null ? 'Claude Code’s skills folder' : <code class={CHIP}>{current.skillsDir}</code>}. Switching one off uses Claude Code’s own setting (skillOverrides); the folder stays. {SKILL_NOTE}
              </CardDescription>
              <div class="pt-2">
                <Button size="sm" data-add-skill onClick={actions.openAdd}>
                  <Plus />
                  Add skill
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {current === null ? (
                <p class="text-muted-foreground text-sm">Loading…</p>
              ) : current.added.length === 0 ? (
                <p class="text-muted-foreground text-sm">No skills added through JERRY yet. Add one from GitHub, a folder or a zip file.</p>
              ) : (
                <ul class="added-skills grid grid-cols-1 gap-3">{current.added.map((skill) => addedTile(skill, actions))}</ul>
              )}
            </CardContent>
          </Card>
          {current !== null && current.own.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.jerry} />
                  JERRY’s skills
                </CardTitle>
                <CardDescription>Part of JERRY’s plugin (/jerry:…); they change with JERRY.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul class="own-skills grid grid-cols-1 gap-3">{current.own.map(otherTile)}</ul>
              </CardContent>
            </Card>
          )}
          {current !== null && current.personal.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.repository} />
                  Your other skills
                </CardTitle>
                <CardDescription>In the skills folder, but not installed by JERRY: JERRY never changes or removes them.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul class="personal-skills grid grid-cols-1 gap-3">{current.personal.map(otherTile)}</ul>
              </CardContent>
            </Card>
          )}
          {actions.dialogs()}
        </div>
      );
    };
  },
});
