import { EMOJI } from '@jerry/contracts/emoji';
import { Activity, ChevronRight, Database, FlaskConical, FolderGit2, LayoutDashboard, ListTodo, LogOut, Settings as SettingsIcon, Sparkles, X } from '@lucide/vue';
import { computed, defineComponent, onMounted, onUnmounted, type PropType } from 'vue';
import { Emoji } from './components/Emoji';
import { Logo } from './components/Logo';
import { StatusBadge } from './components/StatusBadge';
import { ThemeToggle } from './components/ThemeToggle';
import { UsageBar } from './components/UsageBar';
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
import { projectName } from './lib/tasks';
import { linkTo, route, startRouter, type Section } from './router';
import { signOut, state } from './state';
import { Data } from './views/Data';
import { EvalRunPage } from './views/EvalRunPage';
import { shownWorkspace, WorkspacePage } from './views/WorkspacePage';
import { Evals } from './views/Evals';
import { Overview } from './views/Overview';
import { ProjectPage } from './views/ProjectPage';
import { Projects } from './views/Projects';
import { Settings } from './views/Settings';
import { SkillPage } from './views/SkillPage';
import { Skills } from './views/Skills';
import { TaskPage } from './views/TaskPage';
import { Tasks } from './views/Tasks';
import { Timeline } from './views/Timeline';

const VIEWS: Array<{ id: Section; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'timeline', label: 'Timeline', icon: Activity },
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

/**
 * A sidebar link to a section: a real link (it opens in a new tab with Ctrl), highlighted while the
 * section or one of its pages is shown. On a narrow window, choosing it also closes the sidebar sheet.
 */
const SectionLink = defineComponent({
  name: 'SectionLink',
  props: {
    section: { type: String as PropType<Section>, required: true },
    label: { type: String, required: true },
    icon: { type: [Object, Function] as PropType<typeof LayoutDashboard>, required: true },
    current: { type: String as PropType<Section>, required: true },
  },
  setup(props) {
    const { setOpenMobile } = useSidebar();
    return () => {
      const link = linkTo(`#/${props.section}`);
      const active = props.current === props.section;
      return (
        <SidebarMenuButton
          as="a"
          {...{ href: link.href }}
          isActive={active}
          tooltip={props.label}
          aria-current={active ? 'page' : undefined}
          onClick={(event: MouseEvent) => {
            link.onClick(event);
            setOpenMobile(false);
          }}
        >
          <props.icon />
          <span>{props.label}</span>
        </SidebarMenuButton>
      );
    };
  },
});

/** The sidebar's section list. */
const Sections = defineComponent({
  name: 'Sections',
  props: {
    current: { type: String as PropType<Section>, required: true },
    waiting: { type: Number, required: true },
  },
  setup(props) {
    return () => (
      <SidebarMenu aria-label="Sections">
        {VIEWS.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SectionLink section={item.id} label={item.label} icon={item.icon} current={props.current} />
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
    // The address bar decides the view: back and forward work, and a reload stays where it was.
    let stopRouter: (() => void) | null = null;
    onMounted(() => (stopRouter = startRouter()));
    onUnmounted(() => stopRouter?.());

    // A workspace page belongs to Projects in the sidebar and the header.
    const view = computed(() => (route.value.section === 'workspaces' ? 'projects' : route.value.section));
    const waiting = computed(() => state.tasks.filter(waitsForUser).length);
    const title = computed(() => (view.value === 'settings' ? 'Settings' : (VIEWS.find((item) => item.id === view.value)?.label ?? '')));
    /** The page inside a section (a task, a project), shown after the section's name. */
    const page = computed(() => {
      const current = route.value;
      if (current.section === 'tasks' && current.taskId !== undefined) return current.taskId;
      if (current.section === 'projects' && current.repoRoot !== undefined) return projectName(current.repoRoot);
      if (current.section === 'skills' && current.name !== undefined) return current.name;
      if (current.section === 'evals' && current.runId !== undefined) return current.runId;
      if (current.section === 'workspaces') return shownWorkspace.value?.id === current.id ? shownWorkspace.value.name : 'Workspace';
      return null;
    });

    const content = () => {
      const current = route.value;
      switch (current.section) {
        case 'overview':
          return <Overview />;
        case 'tasks':
          return current.taskId === undefined ? <Tasks /> : <TaskPage key={current.taskId} taskId={current.taskId} />;
        case 'projects':
          return current.repoRoot === undefined ? <Projects /> : <ProjectPage key={current.repoRoot} repoRoot={current.repoRoot} />;
        case 'skills':
          return current.name === undefined ? <Skills /> : <SkillPage key={current.name} name={current.name} />;
        case 'timeline':
          return <Timeline />;
        case 'data':
          return <Data />;
        case 'workspaces':
          return <WorkspacePage key={current.id} id={current.id} />;
        case 'evals':
          return current.runId === undefined ? <Evals /> : <EvalRunPage key={current.runId} runId={current.runId} />;
        case 'settings':
          return <Settings />;
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
              <Sections current={view.value} waiting={waiting.value} />
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
            <SidebarMenuItem data-settings>
              <SectionLink section="settings" label="Settings" icon={SettingsIcon} current={view.value} />
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
                {page.value === null ? (
                  <h1 class="text-base font-medium">{title.value}</h1>
                ) : (
                  <nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-1.5 text-base">
                    <a class="text-muted-foreground hover:text-foreground font-medium" {...linkTo(`#/${view.value}`)}>
                      {title.value}
                    </a>
                    <ChevronRight class="text-muted-foreground size-4 shrink-0" />
                    <h1 class="truncate font-medium" aria-current="page">
                      {page.value}
                    </h1>
                  </nav>
                )}
                <div class="ml-auto flex items-center gap-2">
                  <UsageBar />
                  <ThemeToggle />
                </div>
              </div>
            </header>
            <div class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6" data-view={view.value}>
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
