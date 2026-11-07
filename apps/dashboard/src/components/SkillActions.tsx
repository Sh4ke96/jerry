import type { AddedSkill, SkillCandidate, SkillChangeResult, SkillPreview, SkillScanFinding, WorkflowState } from '@jerry/contracts';
import { SKILL_TRIGGER_STATES } from '@jerry/contracts/constants';
import { EMOJI } from '@jerry/contracts/emoji';
import { STATE_LABELS } from '@jerry/workflow';
import { defineComponent, ref, watch, type PropType } from 'vue';
import { api, HttpError, SignedOutError, type SkillPreviewInput } from '../api';
import { formatBytes } from '../format';
import { ATTENTION, CHIP } from '../lib/classes';
import { decisionConfirmation } from '../settings';
import { handleError, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

/** Shown after every change; Core sends the same words. */
export const SKILL_NOTE = 'Applies to new Claude Code sessions.';

/** The scan's findings: red for text that steers the agent and executables, amber for the rest. */
export const SkillScan = defineComponent({
  name: 'SkillScan',
  props: { findings: { type: Array as PropType<SkillScanFinding[]>, required: true } },
  setup(props) {
    return () =>
      props.findings.length === 0 ? (
        <p class="skill-scan text-muted-foreground text-sm">
          <Emoji symbol={EMOJI.pass} />
          The scan found nothing to point out. It reads the files; it cannot prove they are safe.
        </p>
      ) : (
        <ul class="skill-scan grid gap-1.5 text-sm">
          {props.findings.map((finding, index) => (
            <li key={index} data-level={finding.level} class={finding.level === 'danger' ? 'text-destructive' : ATTENTION}>
              <Emoji symbol={finding.level === 'danger' ? EMOJI.blocked : EMOJI.warning} />
              <span class="font-medium">{finding.message}</span> <span class="text-muted-foreground">[{finding.rule}]</span>{' '}
              <code class={CHIP}>
                {finding.file}
                {finding.line === null ? '' : `:${finding.line}`}
              </code>
              {finding.excerpt !== null && <div class="text-muted-foreground mt-0.5 font-mono text-xs break-all">{finding.excerpt}</div>}
            </li>
          ))}
        </ul>
      );
  },
});

/** When JERRY starts an added skill, in one line (tiles and the skill page). */
export function triggerText(skill: Pick<AddedSkill, 'states' | 'jerryTriggered'>): string {
  if (!skill.jerryTriggered) return 'Installed before JERRY started skills: Claude may still pick it on its own. Choose task states to hand it to JERRY.';
  if (skill.states.length === 0) return 'No task state yet: Claude does not use it.';
  return `Started by JERRY in: ${skill.states.map((state) => STATE_LABELS[state]).join(', ')}.`;
}

/**
 * The task states in which JERRY tells Claude to use an added skill: one checkbox per state, in
 * workflow order. Saving follows the decision confirmation setting (one click or the typed name).
 */
export const SkillStates = defineComponent({
  name: 'SkillStates',
  props: {
    skill: { type: Object as PropType<AddedSkill>, required: true },
    onSaved: { type: Function as PropType<() => Promise<unknown> | void>, default: undefined },
  },
  setup(props) {
    const chosen = ref<WorkflowState[]>([...props.skill.states]);
    const confirming = ref(false);
    const busy = ref(false);
    watch(
      () => props.skill.states,
      (states) => (chosen.value = [...states]),
    );
    const changed = (): boolean => !props.skill.jerryTriggered || chosen.value.join() !== props.skill.states.join();
    const toggle = (state: WorkflowState, on: boolean): void => {
      const next = new Set(chosen.value);
      if (on) next.add(state);
      else next.delete(state);
      chosen.value = SKILL_TRIGGER_STATES.filter((candidate) => next.has(candidate));
    };
    const save = (typed: string): void => {
      busy.value = true;
      void (async () => {
        try {
          const result = await api.setSkillStates(props.skill.name, chosen.value, typed);
          confirming.value = false;
          state.notice = `${result.name}: ${result.skill === null ? '' : triggerText(result.skill)} ${result.note}`.trim();
          await props.onSaved?.();
        } catch (error) {
          handleError(error);
        } finally {
          busy.value = false;
        }
      })();
    };
    return () => (
      <div class="skill-states grid gap-3" data-skill-states={props.skill.name}>
        <fieldset class="grid gap-2">
          <legend class="sr-only">Task states in which JERRY tells Claude to use {props.skill.name}</legend>
          <div class="grid gap-2 sm:grid-cols-2">
            {SKILL_TRIGGER_STATES.map((candidate) => {
              const id = `skill-state-${props.skill.name}-${candidate}`;
              return (
                <label key={candidate} for={id} class="hover:bg-muted/50 flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    class="mt-0.5 size-4 accent-current"
                    data-skill-state={candidate}
                    checked={chosen.value.includes(candidate)}
                    disabled={busy.value}
                    onChange={(event: Event) => toggle(candidate, (event.target as HTMLInputElement).checked)}
                  />
                  <span class="grid">
                    <span>{STATE_LABELS[candidate]}</span>
                    <code class="text-muted-foreground text-xs">{candidate}</code>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" data-skill-states-save disabled={busy.value || !changed()} onClick={() => (confirming.value = true)}>
            Save states
          </Button>
          <span class="text-muted-foreground text-xs">{SKILL_NOTE}</span>
        </div>
        {confirming.value && (
          <ConfirmDialog
            key="skill-states"
            title={`When JERRY starts ${props.skill.name}`}
            expected={props.skill.name}
            confirmLabel="Save states"
            mode={decisionConfirmation(state.settings)}
            busy={busy.value}
            onConfirm={save}
            onCancel={() => (confirming.value = false)}
          >
            <p>{chosen.value.length === 0 ? 'No state: Claude will not use this skill.' : `JERRY will tell Claude to use it while a task is in: ${chosen.value.map((candidate) => STATE_LABELS[candidate]).join(', ')}.`}</p>
            {!props.skill.jerryTriggered && <p class="text-xs">Its SKILL.md gets "user-invocable: false" so it leaves the / menu; JERRY copies the folder to its backups first.</p>}
          </ConfirmDialog>
        )}
      </div>
    );
  },
});

/** The skill folders in a preview error's details; [] when there are none (no Zod in the dashboard). */
export function candidatesOf(details: unknown): SkillCandidate[] {
  const list = typeof details === 'object' && details !== null ? (details as { candidates?: unknown }).candidates : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is SkillCandidate => typeof entry === 'object' && entry !== null && typeof (entry as SkillCandidate).folder === 'string' && typeof (entry as SkillCandidate).url === 'string' && (entry as SkillCandidate).url.startsWith('https://github.com/'));
}

/** A file chosen in the browser as base64, in chunks (large files would overflow one call). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** The preview of a skill: what it says, its files and the scan; installing is confirmed as Settings says. */
function previewBody(preview: SkillPreview) {
  const source = preview.source.kind === 'github' ? `${preview.source.source}${preview.source.commit === null ? '' : ` @ ${preview.source.commit.slice(0, 12)}`}` : preview.source.source;
  return (
    <div class="skill-preview grid min-w-0 gap-3 text-sm" data-skill-preview={preview.name}>
      <p>
        <span class="font-semibold">{preview.name}</span>: {preview.description}
      </p>
      <p class="text-muted-foreground text-xs break-all">
        From <code class={CHIP}>{source}</code> into <code class={CHIP}>{preview.targetDir}</code>
      </p>
      <p class="skill-trigger-note text-muted-foreground text-xs">
        <Emoji symbol={EMOJI.jerry} />
        Only JERRY starts this skill: SKILL.md gets "user-invocable: false" (no / menu entry) and Claude sees only its name. Choose the task states on its page; until then Claude does not use it.
      </p>
      {preview.blocked !== null && (
        <Alert variant="destructive" class="skill-blocked">
          <AlertDescription>{preview.blocked}</AlertDescription>
        </Alert>
      )}
      {preview.diff !== null && !preview.upToDate && (
        <p class="skill-diff text-xs">
          {preview.diff.added.length} added, {preview.diff.changed.length} changed, {preview.diff.removed.length} removed
          {[...preview.diff.added.map((file) => `+ ${file}`), ...preview.diff.changed.map((file) => `~ ${file}`), ...preview.diff.removed.map((file) => `- ${file}`)].map((line) => (
            <code key={line} class="block font-mono">
              {line}
            </code>
          ))}
        </p>
      )}
      <div class="grid gap-1">
        <p class="font-medium">Scan</p>
        <SkillScan findings={preview.scan} />
      </div>
      <details class="skill-files">
        <summary class="cursor-pointer font-medium">
          {preview.files.length} file(s), {formatBytes(preview.totalBytes)}
        </summary>
        <ul class="mt-1 grid gap-0.5">
          {preview.files.map((file) => (
            <li key={file.path} class="flex justify-between gap-3 font-mono text-xs">
              <span class="break-all">{file.path}</span>
              <span class="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
            </li>
          ))}
        </ul>
      </details>
      <div class="grid gap-1">
        <p class="font-medium">SKILL.md</p>
        <pre class="skill-md bg-muted max-h-64 overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">{preview.skillMd}</pre>
      </div>
    </div>
  );
}

/**
 * Adding, updating, switching and removing skills, for the Skills view and a skill's page. Nothing
 * changes without a preview; installing, updating and removing are confirmed as the decision
 * confirmation setting says (one click or the typed skill name), switching is one click.
 */
export function useSkillActions(afterChange: () => Promise<unknown> | void = () => undefined) {
  const asking = ref(false);
  const sourceKind = ref<'url' | 'folder' | 'file'>('url');
  const source = ref('');
  const file = ref<File | null>(null);
  const preview = ref<SkillPreview | null>(null);
  const confirming = ref(false);
  const removing = ref<string | null>(null);
  const busy = ref(false);
  /** The skill an update file is chosen for (skills that came from an uploaded file). */
  const updateFileFor = ref<string | null>(null);

  const done = async (result: SkillChangeResult, what: string): Promise<void> => {
    state.notice = `${result.name} ${what}. ${result.note}`;
    await afterChange();
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    busy.value = true;
    try {
      await work();
    } catch (error) {
      handleError(error);
    } finally {
      busy.value = false;
    }
  };

  const inputOf = async (): Promise<SkillPreviewInput | null> => {
    if (sourceKind.value === 'file') {
      if (file.value === null) return null;
      return { upload: { fileName: file.value.name, dataBase64: await fileToBase64(file.value) } };
    }
    const text = source.value.trim();
    return text === '' ? null : { source: text };
  };

  /** Why the last preview failed, shown inside the dialog (the page's notice would sit behind it). */
  const sourceError = ref<string | null>(null);
  /** The skill folders of a repository that holds several, to pick one. */
  const candidates = ref<SkillCandidate[]>([]);

  const openAdd = (): void => {
    source.value = '';
    file.value = null;
    updateFileFor.value = null;
    sourceError.value = null;
    candidates.value = [];
    asking.value = true;
  };

  const readPreview = async (): Promise<void> => {
    const input = await inputOf();
    if (input === null) return;
    busy.value = true;
    sourceError.value = null;
    candidates.value = [];
    try {
      preview.value = updateFileFor.value === null ? await api.previewSkill(input) : await api.previewSkillUpdate(updateFileFor.value, input);
      asking.value = false;
    } catch (error) {
      if (error instanceof SignedOutError) return handleError(error);
      sourceError.value = error instanceof Error ? error.message : String(error);
      candidates.value = error instanceof HttpError ? candidatesOf(error.details) : [];
    } finally {
      busy.value = false;
    }
  };

  const submitSource = (event: Event): void => {
    event.preventDefault();
    void readPreview();
  };

  const pickCandidate = (candidate: SkillCandidate): void => {
    sourceKind.value = 'url';
    source.value = candidate.url;
    void readPreview();
  };

  const checkUpdate = (name: string, fromUpload: boolean): void => {
    if (fromUpload) {
      // An uploaded skill has no source to read again: the user picks the new file.
      sourceKind.value = 'file';
      file.value = null;
      updateFileFor.value = name;
      sourceError.value = null;
      candidates.value = [];
      asking.value = true;
      return;
    }
    void run(async () => {
      const next = await api.previewSkillUpdate(name);
      if (next.upToDate) state.notice = `${name} is up to date.`;
      else preview.value = next;
    });
  };

  const apply = (typed: string): void => {
    const current = preview.value;
    if (current === null) return;
    void run(async () => {
      const result = current.purpose === 'install' ? await api.installSkill(current.previewId, typed) : await api.applySkillUpdate(current.name, current.previewId, typed);
      preview.value = null;
      confirming.value = false;
      await done(result, current.purpose === 'install' ? 'installed' : 'updated');
    });
  };

  const toggle = (name: string, enabled: boolean): void => {
    void run(async () => done(await api.setSkillEnabled(name, enabled), enabled ? 'switched on' : 'switched off'));
  };

  const remove = (typed: string): void => {
    const name = removing.value;
    if (name === null) return;
    void run(async () => {
      const result = await api.removeSkill(name, typed);
      removing.value = null;
      await done(result, `removed (kept in ${result.backupDir ?? "JERRY's backups"})`);
    });
  };

  const sourceDialog = () => (
    <Dialog key="skill-source" open={asking.value} onUpdate:open={(open: boolean) => (asking.value = open)}>
      <DialogContent>
        <form class="add-skill grid gap-4" onSubmit={submitSource}>
          <DialogHeader>
            <DialogTitle>{updateFileFor.value === null ? 'Add a skill' : `New version of ${updateFileFor.value}`}</DialogTitle>
            <DialogDescription>JERRY reads, checks and scans the skill and shows it to you first. Nothing is installed or run before you confirm.</DialogDescription>
          </DialogHeader>
          {updateFileFor.value === null && (
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Where the skill comes from">
              {(
                [
                  ['url', 'GitHub URL'],
                  ['folder', 'Folder on this computer'],
                  ['file', 'Zip or .skill file'],
                ] as const
              ).map(([kind, label]) => (
                <Button key={kind} type="button" size="sm" variant={sourceKind.value === kind ? 'default' : 'outline'} role="radio" aria-checked={sourceKind.value === kind} data-source-kind={kind} onClick={() => (sourceKind.value = kind)}>
                  {label}
                </Button>
              ))}
            </div>
          )}
          {sourceError.value !== null && (
            <Alert variant="destructive" class="skill-source-error" role="alert">
              <AlertDescription>
                <p class="break-words">{candidates.value.length > 0 ? 'This repository holds several skills. Pick one:' : sourceError.value}</p>
                {candidates.value.length > 0 && (
                  <div class="mt-2 flex flex-wrap gap-2">
                    {candidates.value.map((candidate) => (
                      <Button key={candidate.url} type="button" size="sm" variant="outline" data-skill-candidate={candidate.folder} disabled={busy.value} title={candidate.url} onClick={() => pickCandidate(candidate)}>
                        {candidate.folder.slice(candidate.folder.lastIndexOf('/') + 1)}
                      </Button>
                    ))}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
          {sourceKind.value === 'file' ? (
            <div class="grid gap-2">
              <Label for="skill-file">Zip or .skill file</Label>
              <input id="skill-file" type="file" accept=".zip,.skill" class="text-sm" onChange={(event: Event) => (file.value = (event.target as HTMLInputElement).files?.[0] ?? null)} />
            </div>
          ) : (
            <div class="grid gap-2">
              <Label for="skill-source">{sourceKind.value === 'url' ? 'GitHub URL of the skill folder' : 'Full path of the skill folder'}</Label>
              <Input
                id="skill-source"
                class="font-mono"
                placeholder={sourceKind.value === 'url' ? 'https://github.com/owner/repo/tree/main/skills/pdf' : 'D:\\Skills\\pdf'}
                autocomplete="off"
                spellcheck={false}
                modelValue={source.value}
                onUpdate:modelValue={(value: string) => (source.value = value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (asking.value = false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy.value || (sourceKind.value === 'file' ? file.value === null : source.value.trim() === '')}>
              {busy.value ? (sourceKind.value === 'url' ? 'Reading the skill from GitHub…' : 'Reading…') : 'Preview'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  const previewDialog = () => {
    const current = preview.value;
    if (current === null || confirming.value) return null;
    return (
      <Dialog key="skill-preview" open={true} onUpdate:open={(open: boolean) => !open && (preview.value = null)}>
        <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{current.purpose === 'install' ? `Install ${current.name}?` : `Update ${current.name}?`}</DialogTitle>
            <DialogDescription>A skill gives Claude instructions in every session and may tell it to run its scripts. Install only what you have read and trust.</DialogDescription>
          </DialogHeader>
          {previewBody(current)}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (preview.value = null)}>
              Cancel
            </Button>
            {current.blocked === null && (
              <Button type="button" data-skill-confirm onClick={() => (confirming.value = true)}>
                {current.purpose === 'install' ? 'Install…' : 'Update…'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };

  const dialogs = () => [
    sourceDialog(),
    previewDialog(),
    preview.value !== null && confirming.value && (
      <ConfirmDialog
        key="skill-apply"
        title={preview.value.purpose === 'install' ? `Install ${preview.value.name}?` : `Update ${preview.value.name}?`}
        expected={preview.value.name}
        confirmLabel={preview.value.purpose === 'install' ? 'Install skill' : 'Update skill'}
        mode={decisionConfirmation(state.settings)}
        busy={busy.value}
        onConfirm={apply}
        onCancel={() => (confirming.value = false)}
      >
        <p>
          Into <code class="text-foreground font-mono">{preview.value.targetDir}</code>
          {preview.value.purpose === 'update' && "; the installed version goes to JERRY's backups"}.
        </p>
        <p class="text-xs">
          {preview.value.scan.filter((finding) => finding.level === 'danger').length} red and {preview.value.scan.filter((finding) => finding.level === 'warning').length} amber scan finding(s). {SKILL_NOTE}
        </p>
      </ConfirmDialog>
    ),
    removing.value !== null && (
      <ConfirmDialog key="skill-remove" title={`Remove ${removing.value}?`} expected={removing.value} confirmLabel="Remove skill" tone="danger" busy={busy.value} onConfirm={remove} onCancel={() => (removing.value = null)}>
        <p>The skill's folder moves to JERRY's backups, where you can get it back. {SKILL_NOTE}</p>
      </ConfirmDialog>
    ),
  ];

  return { openAdd, checkUpdate, toggle, askRemove: (name: string) => (removing.value = name), dialogs, busy };
}
