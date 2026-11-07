import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { desktopBridge, desktopSettingsUrl, type DesktopSettingsValue } from '../lib/desktop';
import { Emoji } from './Emoji';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';

/** The Windows notification sounds the app offers (settings.rs SOUNDS, plus None), grouped as on its own page. */
export const SOUND_GROUPS: ReadonlyArray<{ label: string | null; sounds: ReadonlyArray<[string, string]> }> = [
  { label: null, sounds: [['None', 'None']] },
  { label: 'Notification sounds', sounds: [['Default', 'Default'], ['IM', 'IM'], ['Mail', 'Mail'], ['Reminder', 'Reminder'], ['SMS', 'SMS']] },
  { label: 'Alarm sounds', sounds: [['Alarm', 'Alarm 1'], ...Array.from({ length: 9 }, (_, index): [string, string] => [`Alarm${index + 2}`, `Alarm ${index + 2}`])] },
  { label: 'Call sounds', sounds: [['Call', 'Call 1'], ...Array.from({ length: 9 }, (_, index): [string, string] => [`Call${index + 2}`, `Call ${index + 2}`])] },
];

type SwitchField = Exclude<keyof DesktopSettingsValue, 'sound'>;

const STARTUP: ReadonlyArray<{ field: SwitchField; label: string; description: string }> = [
  { field: 'launchWithWindows', label: 'Launch with Windows', description: 'Starts Jerry in the tray when you sign in.' },
  { field: 'openWindowOnStart', label: 'Open the window on start', description: 'Otherwise Jerry waits in the tray. Starts with Windows always stay in the tray.' },
];

const NOTIFICATION_TYPES: ReadonlyArray<{ field: SwitchField; label: string; description: string }> = [
  { field: 'planWaiting', label: '📋 Plan waiting', description: 'A plan waits for your approval.' },
  { field: 'reportWaiting', label: '📄 Report waiting', description: 'An implementation report waits for your acceptance.' },
  { field: 'fixesWaiting', label: '🛠️ Fixes waiting', description: 'Review fixes wait for your approval.' },
  { field: 'taskDone', label: '🏁 Task done', description: 'A task was completed.' },
  { field: 'taskBlocked', label: '⛔ Task blocked', description: 'A task is blocked and needs a decision.' },
  { field: 'coreStopped', label: '⚠️ Core stopped', description: 'JERRY Core stopped without you stopping it.' },
];

/**
 * The Jerry app's own settings, inline on the dashboard's Settings page (shown only inside the app).
 * They are read and saved through the app's settings commands, which the app grants the dashboard
 * of its Core and nothing else; every change is saved at once, as on the app's own page. When the
 * app does not offer them (an older Jerry), a button opens its settings page instead.
 */
export const DesktopSettings = defineComponent({
  name: 'DesktopSettings',
  setup() {
    const bridge = desktopBridge();
    const settings = ref<DesktopSettingsValue | null>(null);
    const saving = ref(false);
    const message = ref<{ text: string; error: boolean } | null>(null);

    const load = async (): Promise<void> => {
      if (bridge === null) return;
      try {
        settings.value = await bridge.getSettings();
      } catch (error) {
        message.value = { text: String(error), error: true };
      }
    };
    onMounted(() => void load());

    const save = async (next: DesktopSettingsValue): Promise<void> => {
      if (bridge === null || saving.value) return;
      saving.value = true;
      try {
        settings.value = await bridge.setSettings(next);
        message.value = { text: 'Saved.', error: false };
      } catch (error) {
        message.value = { text: String(error), error: true };
        await load();
      } finally {
        saving.value = false;
      }
    };

    const test = async (sound: string): Promise<void> => {
      if (bridge === null) return;
      try {
        await bridge.sendTestNotification(sound);
        message.value = { text: 'Test notification sent.', error: false };
      } catch (error) {
        message.value = { text: String(error), error: true };
      }
    };

    const option = (current: DesktopSettingsValue, entry: { field: SwitchField; label: string; description: string }, disabled = false) => {
      const id = `desktop-${entry.field}`;
      return (
        <div key={entry.field} class={['flex items-center justify-between gap-4', disabled && 'opacity-50']} data-desktop-option={entry.field}>
          <div class="grid gap-0.5">
            <Label for={id}>{entry.label}</Label>
            <p class="text-muted-foreground text-sm">{entry.description}</p>
          </div>
          <Switch id={id} modelValue={current[entry.field]} disabled={disabled || saving.value} onUpdate:modelValue={(value: boolean) => void save({ ...current, [entry.field]: value })} />
        </div>
      );
    };

    return () => (
      <Card class="settings-desktop">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.jerry} />
            Desktop app
          </CardTitle>
          <CardDescription>The Jerry app on this computer: how it starts and when it notifies you. Changes are saved as soon as you make them.</CardDescription>
        </CardHeader>
        <CardContent class="grid gap-4">
          {bridge === null ? (
            <div class="grid gap-2">
              <p class="text-muted-foreground text-sm">This version of the Jerry app shows its settings on its own page.</p>
              <div>
                {/* A plain link: the Jerry app catches this address and opens its settings page. */}
                <Button as="a" variant="outline" {...{ href: desktopSettingsUrl() }} data-desktop-settings>
                  Desktop app settings…
                </Button>
              </div>
            </div>
          ) : settings.value === null ? (
            <p class="text-muted-foreground text-sm">Loading…</p>
          ) : (
            (() => {
              const current = settings.value;
              const off = !current.notificationsEnabled;
              return (
                <>
                  <div class="desktop-startup grid gap-3">
                    <p class="text-sm font-medium">🚀 Startup</p>
                    {STARTUP.map((entry) => option(current, entry))}
                  </div>
                  <Separator />
                  <div class="desktop-notifications grid gap-3">
                    <p class="text-sm font-medium">🔔 Notifications</p>
                    {option(current, { field: 'notificationsEnabled', label: 'Notifications', description: 'Windows notifications when something needs you; a click on one opens its task.' })}
                    {NOTIFICATION_TYPES.map((entry) => option(current, entry, off))}
                    <div class={['flex flex-wrap items-center justify-between gap-4', off && 'opacity-50']}>
                      <div class="grid gap-0.5">
                        <Label for="desktop-sound">🔊 Sound</Label>
                        <p class="text-muted-foreground text-sm">One of the Windows notification sounds. Alarm and call sounds play once.</p>
                      </div>
                      <div class="flex items-center gap-2">
                        <select
                          id="desktop-sound"
                          class="border-input bg-background h-9 rounded-md border px-3 text-sm"
                          value={current.sound}
                          disabled={off || saving.value}
                          onChange={(event: Event) => void save({ ...current, sound: (event.target as HTMLSelectElement).value })}
                        >
                          {SOUND_GROUPS.map((group) =>
                            group.label === null ? (
                              group.sounds.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))
                            ) : (
                              <optgroup key={group.label} label={group.label}>
                                {group.sounds.map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </optgroup>
                            ),
                          )}
                        </select>
                        <Button size="sm" variant="outline" data-desktop-test onClick={() => void test(current.sound)}>
                          Send test notification
                        </Button>
                      </div>
                    </div>
                  </div>
                </>
              );
            })()
          )}
          {message.value !== null &&
            (message.value.error ? (
              <Alert variant="destructive" class="desktop-message">
                <AlertDescription>{message.value.text}</AlertDescription>
              </Alert>
            ) : (
              <p class="desktop-message text-muted-foreground text-sm" role="status">
                {message.value.text}
              </p>
            ))}
        </CardContent>
      </Card>
    );
  },
});
