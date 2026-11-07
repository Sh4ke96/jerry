import { EMOJI } from '@jerry/contracts/emoji';
import { Activity, Database, FlaskConical, FolderGit2, LayoutDashboard, ListTodo, LogOut, X } from '@lucide/vue';
import { computed, defineComponent, ref, type PropType } from 'vue';
import { Emoji } from './components/Emoji';
import { Logo } from './components/Logo';
import { StatusBadge } from './components/StatusBadge';
import { ThemeToggle } from './components/ThemeToggle';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Separator } from './components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar';
import { Skeleton } from './components/ui/skeleton';
import { waitsForUser } from './format';
import { signOut, state } from './state';
import { Data } from './views/Data';
import { Evals } from './views/Evals';
import { Overview } from './views/Overview';
import { Repositories } from './views/Repositories';
import { Tasks } from './views/Tasks';
import { Timeline } from './views/Timeline';

type View = 'overview' | 'tasks' | 'timeline' | 'repositories' | 'data' | 'evals';

const VIEWS: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'timeline', label: 'Timeline', icon: Activity },
  { id: 'repositories', label: 'Repositories', icon: FolderGit2 },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'evals', label: 'Evals', icon: FlaskConical },
];

/** A page without the sidebar: signed out, or Core did not answer. */
const Standalone = defineComponent({
  name: 'Standalone',
  setup(_props, { slots }) {
    return () => (
      <div class="bg-muted flex min-h-svh items-center justify-center p-6">
        <Card class="w-full max-w-md">
          <CardHeader>
            <div class="flex items-center gap-3">
              <Logo class="size-9" />
              <CardTitle class="text-lg">JERRY Control Center</CardTitle>
            </div>
          </CardHeader>
          <CardContent class="grid gap-4 text-sm">{slots.default?.()}</CardContent>
        </Card>
      </div>
    );
  },
});

/** The sidebar's view list; on a narrow window, choosing a view also closes the sidebar sheet. */
const Sections = defineComponent({
  name: 'Sections',
  props: {
    current: { type: String as PropType<View>, required: true },
    waiting: { type: Number, required: true },
  },
  emits: { select: (view: View) => typeof view === 'string' },
  setup(props, { emit }) {
    const { setOpenMobile } = useSidebar();
    const select = (view: View): void => {
      emit('select', view);
      setOpenMobile(false);
    };
    return () => (
      <SidebarMenu aria-label="Sections">
        {VIEWS.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton isActive={props.current === item.id} tooltip={item.label} aria-current={props.current === item.id ? 'page' : undefined} onClick={() => select(item.id)}>
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
            {item.id === 'tasks' && props.waiting > 0 && (
              <SidebarMenuBadge class="bg-primary text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground peer-hover/menu-button:text-primary-foreground" title={`${props.waiting} waiting for your decision`}>
                {props.waiting}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  },
});

export const App = defineComponent({
  name: 'App',
  setup() {
    const view = ref<View>('overview');
    const waiting = computed(() => state.tasks.filter(waitsForUser).length);
    const title = computed(() => VIEWS.find((item) => item.id === view.value)?.label ?? '');

    const content = () => {
      switch (view.value) {
        case 'overview':
          return <Overview onNavigate={(target: View) => (view.value = target)} />;
        case 'tasks':
          return <Tasks />;
        case 'timeline':
          return <Timeline />;
        case 'repositories':
          return <Repositories />;
        case 'data':
          return <Data />;
        case 'evals':
          return <Evals />;
      }
    };

    const sidebar = () => (
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton as="div" size="lg" class="hover:bg-transparent active:bg-transparent">
                {/* Wrapped: the menu button sizes its own direct svg children as icons. */}
                <span class="flex size-8 shrink-0">
                  <Logo class="size-8" />
                </span>
                <div class="grid flex-1 text-left leading-tight">
                  <span class="truncate font-semibold tracking-wide">JERRY</span>
                  <span class="text-muted-foreground truncate text-xs">Control Center</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Sections</SidebarGroupLabel>
            <SidebarGroupContent>
              <Sections current={view.value} waiting={waiting.value} onSelect={(target: View) => (view.value = target)} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem class="group-data-[collapsible=icon]:hidden">
              <div class="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs" data-guard>
                <StatusBadge tone="pass" emoji={EMOJI.jerry}>
                  GUARDED
                </StatusBadge>
                <span class="text-muted-foreground">Core {state.status?.version}</span>
              </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Sign out" onClick={() => void signOut()}>
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    );

    return () => {
      if (state.phase === 'loading') {
        return (
          <div class="flex min-h-svh" aria-busy="true">
            <div class="bg-sidebar hidden w-64 flex-col gap-3 p-4 md:flex">
              <Skeleton class="h-10 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
            <div class="flex flex-1 flex-col gap-4 p-6">
              <p class="text-muted-foreground text-sm">Connecting to JERRY Core…</p>
              <div class="grid gap-4 md:grid-cols-3">
                <Skeleton class="h-32" />
                <Skeleton class="h-32" />
                <Skeleton class="h-32" />
              </div>
              <Skeleton class="h-64" />
            </div>
          </div>
        );
      }
      if (state.phase === 'signed-out') {
        return (
          <Standalone>
            <p>
              The dashboard session ended. Run <code class="bg-muted rounded px-1 py-0.5">jerry ui</code> in a terminal to open it again.
            </p>
          </Standalone>
        );
      }
      if (state.phase === 'error') {
        return (
          <Standalone>
            <Alert variant="destructive">
              <AlertDescription>
                <p>
                  <Emoji symbol={EMOJI.fail} />
                  JERRY Core did not answer: {state.error}
                </p>
              </AlertDescription>
            </Alert>
          </Standalone>
        );
      }
      return (
        <SidebarProvider>
          {sidebar()}
          <SidebarInset class="min-w-0">
            <header class="bg-background/95 sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b md:rounded-t-xl">
              <div class="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
                <SidebarTrigger class="-ml-1" />
                <Separator orientation="vertical" class="mx-2 data-[orientation=vertical]:h-4" />
                <h1 class="text-base font-medium">{title.value}</h1>
                <div class="ml-auto flex items-center gap-2">
                  <ThemeToggle />
                </div>
              </div>
            </header>
            <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6" data-view={view.value}>
              {state.notice !== null && (
                <Alert role="status" class="flex items-center justify-between gap-3">
                  <AlertDescription class="text-foreground col-start-1">{state.notice}</AlertDescription>
                  <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => (state.notice = null)}>
                    <X />
                  </Button>
                </Alert>
              )}
              {content()}
            </div>
          </SidebarInset>
        </SidebarProvider>
      );
    };
  },
});
