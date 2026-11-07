import { ref } from 'vue';

/**
 * A small hash router: the dashboard is one page served by Core, so every view has an address
 * after `#` that survives a reload and works with the browser's back and forward buttons.
 */

export type Section = 'overview' | 'tasks' | 'projects' | 'skills' | 'timeline' | 'data' | 'evals' | 'settings';

export type Route =
  | { section: 'overview' | 'timeline' | 'data' | 'settings' }
  | { section: 'tasks'; taskId?: string }
  | { section: 'projects'; repoRoot?: string }
  | { section: 'skills'; name?: string }
  | { section: 'evals'; runId?: string };

/** Eval run IDs as Core issues them. */
const EVAL_RUN_ID = /^EVR-\d+$/;

const SECTIONS: ReadonlySet<string> = new Set<Section>(['overview', 'tasks', 'projects', 'skills', 'timeline', 'data', 'evals', 'settings']);

/** Skill names: folder names, or JERRY's own ("jerry:plan"). */
const SKILL_NAME = /^(jerry:)?[a-z0-9][a-z0-9-]{0,63}$/;

/** Task IDs as Core issues them; anything else in the address is not a task. */
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The route of an address hash ("#/tasks/JRY-0001"); null when it names nothing the dashboard has. */
export function parseRoute(hash: string): Route | null {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (path === '') return { section: 'overview' };
  const slash = path.indexOf('/');
  const head = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? '' : path.slice(slash + 1).replace(/\/+$/, '');
  if (!SECTIONS.has(head)) return null;
  if (rest === '') return { section: head as Section } as Route;
  if (head === 'tasks') {
    const taskId = decode(rest);
    return taskId !== null && TASK_ID.test(taskId) ? { section: 'tasks', taskId } : null;
  }
  if (head === 'skills') {
    const name = decode(rest);
    return name !== null && SKILL_NAME.test(name) ? { section: 'skills', name } : null;
  }
  if (head === 'projects') {
    const repoRoot = decode(rest);
    return repoRoot !== null && repoRoot.trim() !== '' ? { section: 'projects', repoRoot } : null;
  }
  if (head === 'evals') {
    const runId = decode(rest);
    return runId !== null && EVAL_RUN_ID.test(runId) ? { section: 'evals', runId } : null;
  }
  return null;
}

/** The address of a route, for links: "#/projects/D%3A%5CWork%5Cshop". */
export function hrefOf(route: Route): string {
  if (route.section === 'tasks' && route.taskId !== undefined) return `#/tasks/${encodeURIComponent(route.taskId)}`;
  if (route.section === 'projects' && route.repoRoot !== undefined) return `#/projects/${encodeURIComponent(route.repoRoot)}`;
  if (route.section === 'skills' && route.name !== undefined) return `#/skills/${encodeURIComponent(route.name)}`;
  if (route.section === 'evals' && route.runId !== undefined) return `#/evals/${encodeURIComponent(route.runId)}`;
  return `#/${route.section}`;
}

export const taskHref = (taskId: string): string => hrefOf({ section: 'tasks', taskId });
export const projectHref = (repoRoot: string): string => hrefOf({ section: 'projects', repoRoot });
export const skillHref = (name: string): string => hrefOf({ section: 'skills', name });
export const evalRunHref = (runId: string): string => hrefOf({ section: 'evals', runId });

/** The current route; unknown addresses show the overview. */
export const route = ref<Route>({ section: 'overview' });

function currentHash(): string {
  try {
    return window.location.hash;
  } catch {
    return '';
  }
}

/** Reads the address bar; an unknown address is replaced by the overview's (without a new history entry). */
export function syncRoute(): void {
  const parsed = parseRoute(currentHash());
  if (parsed !== null) {
    route.value = parsed;
    return;
  }
  route.value = { section: 'overview' };
  try {
    window.history.replaceState(window.history.state, '', hrefOf(route.value));
  } catch {
    // no history API: the overview shows anyway
  }
}

/** Goes to a route: a new history entry, so the back button returns. */
export function navigate(target: Route | string): void {
  const href = typeof target === 'string' ? target : hrefOf(target);
  const parsed = parseRoute(href) ?? { section: 'overview' };
  route.value = parsed;
  if (currentHash() !== href) {
    try {
      window.location.hash = href;
    } catch {
      // the route is shown even where the address cannot change
    }
  }
  try {
    window.scrollTo({ top: 0 });
  } catch {
    // not every environment scrolls
  }
}

/** Follows the address bar (back, forward, typed addresses) until the returned function is called. */
export function startRouter(): () => void {
  syncRoute();
  const listener = (): void => syncRoute();
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}

/**
 * Props for an element that leads to a route: a real link (it opens in a new tab with Ctrl or the
 * middle button) whose plain click is handled here, so the view changes at once.
 */
export function linkTo(target: Route | string): { href: string; onClick: (event: MouseEvent) => void } {
  const href = typeof target === 'string' ? target : hrefOf(target);
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    },
  };
}
