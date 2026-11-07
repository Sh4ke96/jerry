import { Monitor, Moon, Sun } from '@lucide/vue';
import { defineComponent } from 'vue';
import { setTheme, theme, type ThemeChoice } from '../lib/theme';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

const CHOICES: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light, dark or the system's theme, like the mode toggle on ui.shadcn.com. */
export const ThemeToggle = defineComponent({
  name: 'ThemeToggle',
  setup() {
    return () => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" class="size-8" data-theme-toggle>
            <Sun class="size-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
            <Moon class="absolute size-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            <span class="sr-only">Theme</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-40">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup modelValue={theme.value} onUpdate:modelValue={(value: string) => setTheme(value as ThemeChoice)}>
            {CHOICES.map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                <choice.icon />
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
});
