import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api } from '../api';
import { Emoji } from '../components/Emoji';
import { Segmented } from '../components/Segmented';
import { UsageSettings } from '../components/UsageSettings';
import { Button } from '../components/ui/button';
import { desktopSettingsUrl, inJerryDesktop } from '../lib/desktop';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { setTheme, theme, type ThemeChoice } from '../lib/theme';
import { decisionConfirmation, QA_LANGUAGE_LABEL, REVIEW_MODE_LABEL, type QaLanguage, type ReviewMode, type SettingsUpdate } from '../settings';
import { loadSettings, state } from '../state';

const REVIEW_OPTIONS: Array<{ value: ReviewMode; label: string; hint: string }> = [
  { value: 'optional', label: REVIEW_MODE_LABEL.optional, hint: 'When you accept a report you choose whether it goes to the independent review; without it, JERRY runs the final checks right away.' },
  { value: 'required', label: REVIEW_MODE_LABEL.required, hint: 'Every accepted report goes to the independent review: three read-only reviewers check each changed file before the final checks.' },
];

const QA_OPTIONS: Array<{ value: QaLanguage; label: string }> = [
  { value: 'pl', label: QA_LANGUAGE_LABEL.pl },
  { value: 'en', label: QA_LANGUAGE_LABEL.en },
];

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** The user's settings: how the workflow runs, and how the dashboard looks. Each change is saved at once. */
export const Settings = defineComponent({
  name: 'Settings',
  setup() {
    /** Inside the Jerry app's window, which marks its user agent. */
    const desktop = inJerryDesktop();
    const saving = ref(false);
    const error = ref<string | null>(null);
    const loaded = ref(state.settings !== null);
    onMounted(async () => {
      await loadSettings();
      loaded.value = true;
    });

    const save = async (update: SettingsUpdate, success: string): Promise<void> => {
      saving.value = true;
      error.value = null;
      try {
        state.settings = await api.saveSettings(update);
        state.notice = success;
      } catch (failure) {
        error.value = failure instanceof Error ? failure.message : String(failure);
      } finally {
        saving.value = false;
      }
    };

    const workflow = () => {
      const settings = state.settings;
      if (settings === null) {
        if (!loaded.value) return <Skeleton class="h-24" />;
        return (
          <Alert variant="destructive" class="settings-unavailable">
            <AlertTitle>
              <Emoji symbol={EMOJI.warning} />
              Settings are not available
            </AlertTitle>
            <AlertDescription>
              <p>This JERRY Core does not offer workflow settings yet. Update JERRY and restart Core to choose the review mode and the QA language.</p>
            </AlertDescription>
          </Alert>
        );
      }
      const hint = REVIEW_OPTIONS.find((option) => option.value === settings.reviewMode)?.hint;
      const typedDecisions = decisionConfirmation(settings) === 'typed';
      return (
        <div class="grid gap-6">
          <div class="grid gap-2">
            <Label>Independent review</Label>
            <Segmented
              label="Independent review"
              class="settings-review"
              options={REVIEW_OPTIONS}
              modelValue={settings.reviewMode}
              disabled={saving.value}
              onUpdate:modelValue={(value: string) => void save({ reviewMode: value as ReviewMode }, `Saved: review is ${value} now.`)}
            />
            <p class="text-muted-foreground text-sm">{hint}</p>
            <p class="text-muted-foreground text-xs">A project can override this on its page. Tasks already in review can always be finished with Skip review.</p>
          </div>
          <div class="grid gap-2">
            <Label>Language of QA scenarios</Label>
            <Segmented
              label="Language of QA scenarios"
              class="settings-qa"
              options={QA_OPTIONS}
              modelValue={settings.qaLanguage}
              disabled={saving.value}
              onUpdate:modelValue={(value: string) => void save({ qaLanguage: value as QaLanguage }, `Saved: QA scenarios are written in ${QA_LANGUAGE_LABEL[value as QaLanguage]}.`)}
            />
            <p class="text-muted-foreground text-sm">Claude writes the manual QA scenarios of /jerry:report in this language; the report records which one it used.</p>
          </div>
          <div class="settings-confirmation grid gap-2">
            <div class="flex items-center gap-3">
              <Switch
                id="settings-typed-confirmation"
                modelValue={typedDecisions}
                disabled={saving.value}
                onUpdate:modelValue={(value: boolean) =>
                  void save(
                    { decisionConfirmation: value ? 'typed' : 'click' },
                    value ? 'Saved: decisions need the task ID typed.' : 'Saved: decisions are one click in a confirmation dialog.',
                  )
                }
              />
              <Label for="settings-typed-confirmation">Type the task ID to confirm decisions</Label>
            </div>
            <p class="text-muted-foreground text-sm">
              {typedDecisions
                ? 'Approving, rejecting, accepting, skipping review and the other reversible decisions ask you to type the task ID.'
                : 'Approving, rejecting, accepting, skipping review and the other reversible decisions are one click in a confirmation dialog.'}
            </p>
            <p class="text-muted-foreground text-xs">Irreversible actions (cancelling a task, removing a project, deleting or forgetting data) always ask for a typed confirmation.</p>
          </div>
        </div>
      );
    };

    return () => (
      <div class="settings flex flex-col gap-4 md:gap-6">
        <Card class="settings-workflow">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.plan} />
              Workflow
            </CardTitle>
            <CardDescription>How JERRY runs your tasks. Only you change these; Claude cannot.</CardDescription>
          </CardHeader>
          <CardContent class="grid gap-4">
            {workflow()}
            {error.value !== null && (
              <Alert variant="destructive" class="settings-error">
                <AlertTitle>
                  <Emoji symbol={EMOJI.fail} />
                  Not saved
                </AlertTitle>
                <AlertDescription>
                  <p>{error.value}</p>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
        <UsageSettings />
        <Card class="settings-appearance">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.artifact} />
              Appearance
            </CardTitle>
            <CardDescription>Stored in this browser only.</CardDescription>
          </CardHeader>
          <CardContent class="grid gap-2">
            <Label>Theme</Label>
            <Segmented label="Theme" class="settings-theme" options={THEME_OPTIONS} modelValue={theme.value} onUpdate:modelValue={(value: string) => setTheme(value as ThemeChoice)} />
            <p class="text-muted-foreground text-sm">System follows the operating system's light or dark mode.</p>
          </CardContent>
        </Card>
        {desktop && (
          <Card class="settings-desktop">
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.jerry} />
                Desktop app
              </CardTitle>
              <CardDescription>Notifications, launching with Windows and the other settings of the Jerry app open in its own window.</CardDescription>
            </CardHeader>
            <CardContent>
              {/* A plain link: the Jerry app catches this address and opens its settings window (no IPC). */}
              <Button as="a" variant="outline" {...{ href: desktopSettingsUrl() }} data-desktop-settings>
                Desktop app settings…
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  },
});
