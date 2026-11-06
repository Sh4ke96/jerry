/**
 * The implementation task DAG: plan steps ordered by their dependencies into layers;
 * steps in one layer do not depend on each other and may run in parallel (at most three at a time).
 */

export interface PlanStepNode {
  step: string;
  files: readonly string[];
  dependsOn: readonly number[];
}

export interface PlanLayers {
  /** Step numbers (1-based) per layer, in order. */
  layers: number[][];
  /** Steps that cannot be ordered: a dependency cycle, or dependencies on missing steps. */
  blocked: number[];
}

export function planLayers(steps: readonly PlanStepNode[]): PlanLayers {
  const count = steps.length;
  const valid = (dependency: number): boolean => dependency >= 1 && dependency <= count;
  const remaining = new Set(steps.map((_step, index) => index + 1));
  const done = new Set<number>();
  const layers: number[][] = [];
  for (;;) {
    const ready = [...remaining].filter((number) => steps[number - 1]!.dependsOn.every((dependency) => valid(dependency) && dependency !== number && done.has(dependency)));
    if (ready.length === 0) break;
    layers.push(ready);
    for (const number of ready) {
      remaining.delete(number);
      done.add(number);
    }
  }
  return { layers, blocked: [...remaining] };
}

/** The literal part of a glob before its first wildcard (`src/auth/**` → `src/auth/`). */
function staticPrefix(glob: string): string {
  const normalized = glob.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const wildcard = normalized.search(/[*?[{]/);
  return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

/**
 * Whether two file globs may name the same file. Conservative: when in doubt it says yes, so
 * implementers never share a file by accident.
 */
export function globsOverlap(a: string, b: string, caseInsensitive: boolean): boolean {
  const key = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const left = key(staticPrefix(a));
  const right = key(staticPrefix(b));
  const leftExact = left === key(a.trim().replaceAll('\\', '/').replace(/^\.\//, ''));
  const rightExact = right === key(b.trim().replaceAll('\\', '/').replace(/^\.\//, ''));
  if (leftExact && rightExact) return left === right;
  if (leftExact) return left.startsWith(right);
  if (rightExact) return right.startsWith(left);
  return left.startsWith(right) || right.startsWith(left);
}
