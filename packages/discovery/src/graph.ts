import path from 'node:path';
import type { ReadFile } from './detectors.js';

/**
 * Links between repositories (spec §14.1, ADR 0021): which repository depends on which, from
 * evidence in their manifests and code-generation configs. Read-only and heuristic; every edge
 * carries the evidence it came from.
 */

export interface PackageInfo {
  /** Manifest the package is declared in. */
  manifest: string;
  ecosystem: 'npm' | 'composer' | 'go' | 'cargo' | 'python';
  /** Published name (npm name, Composer name, Go module path, crate, Python project), if any. */
  name: string | null;
  dependencies: string[];
  /** Dependencies given as relative paths (file:, link:, path repositories, replace =>, path =). */
  localPaths: string[];
}

export interface ContractReference {
  /** Config or manifest that points at the schema. */
  source: string;
  /** The path as written, relative to the source's directory. */
  target: string;
}

export interface GraphNode {
  repoRoot: string;
  names: string[];
  apiSchemas: string[];
}

export interface GraphInput extends GraphNode {
  packages: ReadonlyArray<Pick<PackageInfo, 'manifest' | 'dependencies' | 'localPaths'>>;
  contractReferences: readonly ContractReference[];
}

export interface GraphEdge {
  /** The dependent repository. */
  from: string;
  /** The repository it depends on. */
  to: string;
  kind: 'local-path' | 'package' | 'api-contract';
  evidence: string;
}

const dirName = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function parseJson(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Package identity and dependencies per manifest (npm, Composer, Go, Cargo, Python). */
export function detectPackages(manifests: ReadonlyArray<{ path: string; kind: string }>, read: ReadFile): PackageInfo[] {
  const packages: PackageInfo[] = [];
  for (const manifest of manifests) {
    const text = read(manifest.path);
    if (text === null) continue;
    if (manifest.kind === 'npm') {
      const json = parseJson(text);
      const dependencies: string[] = [];
      const localPaths: string[] = [];
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [name, spec] of Object.entries(record(json[field]))) {
          dependencies.push(name);
          if (typeof spec === 'string' && /^(file|link|portal):/.test(spec)) localPaths.push(spec.replace(/^(file|link|portal):/, ''));
        }
      }
      packages.push({ manifest: manifest.path, ecosystem: 'npm', name: typeof json['name'] === 'string' ? json['name'] : null, dependencies, localPaths });
    } else if (manifest.kind === 'composer') {
      const json = parseJson(text);
      const repositories = Array.isArray(json['repositories']) ? (json['repositories'] as unknown[]) : Object.values(record(json['repositories']));
      const localPaths = repositories.map(record).filter((entry) => entry['type'] === 'path' && typeof entry['url'] === 'string').map((entry) => entry['url'] as string);
      packages.push({ manifest: manifest.path, ecosystem: 'composer', name: typeof json['name'] === 'string' ? json['name'] : null, dependencies: [...Object.keys(record(json['require'])), ...Object.keys(record(json['require-dev']))], localPaths });
    } else if (manifest.kind === 'go' && manifest.path.endsWith('go.mod')) {
      const name = /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
      const dependencies = [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v[\d.]+/gm)].map((match) => match[1]!);
      const localPaths = [...text.matchAll(/=>\s*(\.{1,2}\/[^\s]+)/g)].map((match) => match[1]!);
      packages.push({ manifest: manifest.path, ecosystem: 'go', name, dependencies, localPaths });
    } else if (manifest.kind === 'cargo') {
      const name = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? null;
      const section = /\[(?:dev-)?dependencies\]([^[]*)/g;
      const dependencies: string[] = [];
      for (const match of text.matchAll(section)) for (const line of match[1]!.matchAll(/^\s*([\w-]+)\s*=/gm)) dependencies.push(line[1]!);
      const localPaths = [...text.matchAll(/\bpath\s*=\s*"([^"]+)"/g)].map((match) => match[1]!);
      packages.push({ manifest: manifest.path, ecosystem: 'cargo', name, dependencies, localPaths });
    } else if (manifest.kind === 'python' && manifest.path.endsWith('pyproject.toml')) {
      const name = /\[project\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? /\[tool\.poetry\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? null;
      const dependencies = [...text.matchAll(/["']([A-Za-z][\w.-]*)(?:\[[^\]]*\])?\s*(?:[<>=~!;,"']|$)/gm)].map((match) => match[1]!).filter((dependency) => dependency !== name);
      const localPaths = [...text.matchAll(/\bpath\s*=\s*"([^"]+)"|file:(\.{1,2}\/[^\s"']+)/g)].map((match) => (match[1] ?? match[2])!);
      packages.push({ manifest: manifest.path, ecosystem: 'python', name, dependencies, localPaths });
    }
  }
  return packages;
}

const CONTRACT_CONFIG = /(^|\/)(package\.json|openapitools\.json|nswag\.json|orval\.config\.[cm]?[jt]s|openapi-ts\.config\.[cm]?[jt]s|codegen\.ya?ml|\.graphqlrc(\.ya?ml|\.json)?|buf\.gen\.ya?ml)$/;

/** Paths in code-generation configs that leave the repository and point at a schema file. */
export function detectContractReferences(files: readonly string[], read: ReadFile): ContractReference[] {
  const references: ContractReference[] = [];
  for (const file of files) {
    if (!CONTRACT_CONFIG.test(file)) continue;
    const text = read(file);
    if (text === null) continue;
    for (const match of text.matchAll(/((?:\.\.[\\/])+[^\s"'`,;)]+\.(?:ya?ml|json|graphqls?|gql|proto))/g)) {
      const target = match[1]!.replaceAll('\\', '/');
      if (!references.some((reference) => reference.source === file && reference.target === target)) references.push({ source: file, target });
    }
  }
  return references;
}

const comparable = (value: string): string => {
  const resolved = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

/** Edges between known repositories; a repository is never linked to itself. */
export function buildWorkspaceGraph(repositories: readonly GraphInput[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const roots = repositories.map((repository) => ({ repository, key: comparable(repository.repoRoot) }));
  const owner = (absolute: string): GraphInput | null => {
    const key = comparable(absolute);
    // The deepest root wins (nested repositories).
    const match = roots.filter((root) => inside(key, root.key)).sort((a, b) => b.key.length - a.key.length)[0];
    return match?.repository ?? null;
  };
  const byName = new Map<string, GraphInput>();
  for (const repository of repositories) for (const name of repository.names) byName.set(name, repository);

  const edges: GraphEdge[] = [];
  const add = (edge: GraphEdge): void => {
    if (comparable(edge.from) === comparable(edge.to)) return;
    if (!edges.some((existing) => existing.from === edge.from && existing.to === edge.to && existing.kind === edge.kind)) edges.push(edge);
  };
  for (const repository of repositories) {
    for (const pkg of repository.packages) {
      for (const local of pkg.localPaths) {
        const target = owner(path.resolve(repository.repoRoot, dirName(pkg.manifest), local));
        if (target !== null) add({ from: repository.repoRoot, to: target.repoRoot, kind: 'local-path', evidence: `${pkg.manifest} → ${local}` });
      }
      for (const dependency of pkg.dependencies) {
        const target = byName.get(dependency);
        if (target !== undefined) add({ from: repository.repoRoot, to: target.repoRoot, kind: 'package', evidence: `${pkg.manifest} depends on ${dependency}` });
      }
    }
    for (const reference of repository.contractReferences) {
      const absolute = path.resolve(repository.repoRoot, dirName(reference.source), reference.target);
      const target = owner(absolute);
      if (target === null) continue;
      const relative = comparable(absolute).slice(comparable(target.repoRoot).length + 1);
      const isSchema = target.apiSchemas.some((schema) => comparable(path.resolve(target.repoRoot, schema)) === comparable(absolute));
      add({ from: repository.repoRoot, to: target.repoRoot, kind: 'api-contract', evidence: `${reference.source} uses ${isSchema ? 'API schema' : 'file'} ${relative}` });
    }
  }
  return { nodes: repositories.map(({ repoRoot, names, apiSchemas }) => ({ repoRoot, names, apiSchemas })), edges };
}
