/**
 * Detectors: what a repository is made of, from its file list and a few small manifest
 * files. Pure functions: they read through the given reader and never run anything. Commands are
 * reported as the project defines them, for Claude and the user to run.
 */

export type ReadFile = (relativePath: string) => string | null;

export type ManifestKind = 'npm' | 'composer' | 'python' | 'go' | 'cargo' | 'dotnet' | 'maven' | 'gradle' | 'ruby' | 'make';
export type CommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'format' | 'check';

export interface Manifest {
  path: string;
  kind: ManifestKind;
  /** The lockfile next to it, if any. */
  lockfile: string | null;
}

export interface DetectedCommand {
  kind: CommandKind;
  command: string;
  /** Where it was found: a manifest path and script name, or a convention. */
  source: string;
}

export interface RepositoryScan {
  languages: Array<{ name: string; files: number }>;
  manifests: Manifest[];
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  frameworks: Array<{ name: string; evidence: string }>;
  commands: DetectedCommand[];
  ci: Array<{ path: string; kind: string }>;
  containers: Array<{ path: string; kind: string }>;
  apiSchemas: Array<{ path: string; kind: 'openapi' | 'graphql' | 'protobuf' }>;
  migrations: Array<{ path: string; kind: string; files: number }>;
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  vue: 'Vue', svelte: 'Svelte',
  py: 'Python', php: 'PHP', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  cs: 'C#', fs: 'F#', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', scala: 'Scala',
  dart: 'Dart', ex: 'Elixir', exs: 'Elixir', sql: 'SQL', sh: 'Shell', ps1: 'PowerShell',
  css: 'CSS', scss: 'SCSS', html: 'HTML',
};

const LOCKFILES: ReadonlyArray<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
];

/** Dependency name → framework or tool, for package.json, composer.json and Python manifests. */
const FRAMEWORKS: ReadonlyArray<[RegExp, string]> = [
  [/^next$/, 'Next.js'], [/^nuxt$/, 'Nuxt'], [/^react$/, 'React'], [/^vue$/, 'Vue'], [/^svelte$/, 'Svelte'], [/^@angular\/core$/, 'Angular'],
  [/^vite$/, 'Vite'], [/^express$/, 'Express'], [/^fastify$/, 'Fastify'], [/^@nestjs\/core$/, 'NestJS'], [/^hono$/, 'Hono'],
  [/^vitest$/, 'Vitest'], [/^jest$/, 'Jest'], [/^@playwright\/test$/, 'Playwright'], [/^cypress$/, 'Cypress'], [/^mocha$/, 'Mocha'],
  [/^prisma$|^@prisma\/client$/, 'Prisma'], [/^typeorm$/, 'TypeORM'], [/^sequelize$/, 'Sequelize'], [/^kysely$/, 'Kysely'], [/^drizzle-orm$/, 'Drizzle'],
  [/^laravel\/framework$/, 'Laravel'], [/^symfony\/framework-bundle$/, 'Symfony'], [/^phpunit\/phpunit$/, 'PHPUnit'], [/^pestphp\/pest$/, 'Pest'],
  [/^django$/i, 'Django'], [/^flask$/i, 'Flask'], [/^fastapi$/i, 'FastAPI'], [/^pytest$/i, 'pytest'], [/^sqlalchemy$/i, 'SQLAlchemy'], [/^alembic$/i, 'Alembic'],
];

const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);
const dirName = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function detectLanguages(files: readonly string[]): RepositoryScan['languages'] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGES[extensionOf(file)];
    if (language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
}

export function detectManifests(files: readonly string[]): Manifest[] {
  const present = new Set(files);
  const manifests: Manifest[] = [];
  for (const file of files) {
    const name = baseName(file);
    const dir = dirName(file);
    const lock = (...candidates: string[]): string | null => candidates.map((candidate) => join(dir, candidate)).find((candidate) => present.has(candidate)) ?? null;
    let kind: ManifestKind | null = null;
    let lockfile: string | null = null;
    if (name === 'package.json') {
      kind = 'npm';
      lockfile = lock(...LOCKFILES.map(([lockName]) => lockName));
    } else if (name === 'composer.json') {
      kind = 'composer';
      lockfile = lock('composer.lock');
    } else if (name === 'pyproject.toml' || name === 'requirements.txt' || name === 'setup.py' || name === 'Pipfile') {
      kind = 'python';
      lockfile = lock('poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock');
    } else if (name === 'go.mod') {
      kind = 'go';
      lockfile = lock('go.sum');
    } else if (name === 'Cargo.toml') {
      kind = 'cargo';
      lockfile = lock('Cargo.lock');
    } else if (/\.(csproj|fsproj|sln)$/i.test(name)) {
      kind = 'dotnet';
      lockfile = lock('packages.lock.json');
    } else if (name === 'pom.xml') {
      kind = 'maven';
    } else if (name === 'build.gradle' || name === 'build.gradle.kts') {
      kind = 'gradle';
    } else if (name === 'Gemfile') {
      kind = 'ruby';
      lockfile = lock('Gemfile.lock');
    } else if (name === 'Makefile' || name === 'makefile') {
      kind = 'make';
    }
    if (kind !== null) manifests.push({ path: file, kind, lockfile });
  }
  return manifests;
}

export function detectPackageManager(files: readonly string[], read: ReadFile): RepositoryScan['packageManager'] {
  const declared = parseJson(read('package.json'))?.['packageManager'];
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name;
  }
  const present = new Set(files);
  for (const [lockName, manager] of LOCKFILES) if (present.has(lockName)) return manager as RepositoryScan['packageManager'];
  return present.has('package.json') ? 'npm' : null;
}

const SCRIPT_KINDS: ReadonlyArray<[RegExp, CommandKind]> = [
  [/^test$/, 'test'], [/^test:(unit|all|ci)$/, 'test'], [/^build$/, 'build'], [/^lint$/, 'lint'],
  [/^(typecheck|type-check|types|tsc)$/, 'typecheck'], [/^(format|fmt|prettier)$/, 'format'], [/^check$/, 'check'],
];

export function detectCommands(manifests: readonly Manifest[], read: ReadFile, packageManager: RepositoryScan['packageManager']): DetectedCommand[] {
  const commands: DetectedCommand[] = [];
  const runner = packageManager ?? 'npm';
  for (const manifest of manifests) {
    const dir = dirName(manifest.path);
    const where = dir === '' ? '' : ` (in ${dir})`;
    if (manifest.kind === 'npm') {
      const scripts = record(parseJson(read(manifest.path))?.['scripts']);
      for (const [name, value] of Object.entries(scripts)) {
        if (typeof value !== 'string') continue;
        const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(name))?.[1];
        if (kind !== undefined) commands.push({ kind, command: `${runner} run ${name}${where}`, source: `${manifest.path} scripts.${name}` });
      }
    } else if (manifest.kind === 'composer') {
      const scripts = record(parseJson(read(manifest.path))?.['scripts']);
      for (const name of Object.keys(scripts)) {
        const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(name))?.[1];
        if (kind !== undefined) commands.push({ kind, command: `composer run ${name}${where}`, source: `${manifest.path} scripts.${name}` });
      }
    } else if (manifest.kind === 'make') {
      const text = read(manifest.path) ?? '';
      for (const match of text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)) {
        const name = match[1]!;
        const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(name))?.[1];
        if (kind !== undefined) commands.push({ kind, command: `make ${name}${where}`, source: `${manifest.path} target ${name}` });
      }
    } else if (manifest.kind === 'python' && baseName(manifest.path) === 'pyproject.toml') {
      const text = read(manifest.path) ?? '';
      if (/\[tool\.pytest|\bpytest\b/.test(text)) commands.push({ kind: 'test', command: `pytest${where}`, source: `${manifest.path} (pytest)` });
      if (/\[tool\.ruff/.test(text)) commands.push({ kind: 'lint', command: `ruff check${where}`, source: `${manifest.path} [tool.ruff]` });
      if (/\[tool\.mypy/.test(text)) commands.push({ kind: 'typecheck', command: `mypy${where}`, source: `${manifest.path} [tool.mypy]` });
    } else if (manifest.kind === 'go') {
      commands.push({ kind: 'test', command: `go test ./...${where}`, source: `${manifest.path} (convention)` }, { kind: 'build', command: `go build ./...${where}`, source: `${manifest.path} (convention)` }, { kind: 'lint', command: `go vet ./...${where}`, source: `${manifest.path} (convention)` });
    } else if (manifest.kind === 'cargo') {
      commands.push({ kind: 'test', command: `cargo test${where}`, source: `${manifest.path} (convention)` }, { kind: 'build', command: `cargo build${where}`, source: `${manifest.path} (convention)` }, { kind: 'lint', command: `cargo clippy${where}`, source: `${manifest.path} (convention)` });
    } else if (manifest.kind === 'dotnet' && /\.sln$/i.test(manifest.path)) {
      commands.push({ kind: 'test', command: `dotnet test ${manifest.path}`, source: `${manifest.path} (convention)` }, { kind: 'build', command: `dotnet build ${manifest.path}`, source: `${manifest.path} (convention)` });
    } else if (manifest.kind === 'maven') {
      commands.push({ kind: 'test', command: `mvn test${where}`, source: `${manifest.path} (convention)` });
    } else if (manifest.kind === 'gradle') {
      commands.push({ kind: 'test', command: `gradle test${where}`, source: `${manifest.path} (convention)` });
    }
  }
  return commands;
}

export function detectFrameworks(manifests: readonly Manifest[], read: ReadFile): RepositoryScan['frameworks'] {
  const found = new Map<string, string>();
  const note = (dependency: string, manifest: string): void => {
    const framework = FRAMEWORKS.find(([pattern]) => pattern.test(dependency))?.[1];
    if (framework !== undefined && !found.has(framework)) found.set(framework, `${dependency} in ${manifest}`);
  };
  for (const manifest of manifests) {
    if (manifest.kind === 'npm' || manifest.kind === 'composer') {
      const json = parseJson(read(manifest.path));
      for (const field of manifest.kind === 'npm' ? ['dependencies', 'devDependencies', 'peerDependencies'] : ['require', 'require-dev']) {
        for (const dependency of Object.keys(record(json?.[field]))) note(dependency, manifest.path);
      }
    } else if (manifest.kind === 'python') {
      const text = read(manifest.path) ?? '';
      // Quoted requirement strings (pyproject, setup.py) and bare lines (requirements.txt).
      for (const match of text.matchAll(/["']([A-Za-z][\w.-]*)(?:\[[^\]]*\])?\s*(?:[<>=~!;,"']|$)/gm)) note(match[1]!, manifest.path);
      for (const match of text.matchAll(/^([A-Za-z][\w.-]*)(?:\[[^\]]*\])?\s*(?:[<>=~!;]|$)/gm)) note(match[1]!, manifest.path);
    } else if (manifest.kind === 'dotnet' && /\.csproj$/i.test(manifest.path)) {
      if (/Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/.test(read(manifest.path) ?? '') && !found.has('ASP.NET Core')) found.set('ASP.NET Core', manifest.path);
    } else if (manifest.kind === 'ruby') {
      if (/gem ['"]rails['"]/.test(read(manifest.path) ?? '') && !found.has('Rails')) found.set('Rails', manifest.path);
    } else if (manifest.kind === 'maven' || manifest.kind === 'gradle') {
      if (/spring-boot/.test(read(manifest.path) ?? '') && !found.has('Spring Boot')) found.set('Spring Boot', manifest.path);
    }
  }
  return [...found.entries()].map(([name, evidence]) => ({ name, evidence }));
}

export function detectCi(files: readonly string[]): RepositoryScan['ci'] {
  const ci: RepositoryScan['ci'] = [];
  for (const file of files) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) ci.push({ path: file, kind: 'github-actions' });
    else if (file === '.gitlab-ci.yml') ci.push({ path: file, kind: 'gitlab-ci' });
    else if (/^azure-pipelines\.ya?ml$/.test(file)) ci.push({ path: file, kind: 'azure-pipelines' });
    else if (file === '.circleci/config.yml') ci.push({ path: file, kind: 'circleci' });
    else if (file === 'Jenkinsfile') ci.push({ path: file, kind: 'jenkins' });
    else if (file === 'bitbucket-pipelines.yml') ci.push({ path: file, kind: 'bitbucket' });
  }
  return ci;
}

export function detectContainers(files: readonly string[]): RepositoryScan['containers'] {
  const containers: RepositoryScan['containers'] = [];
  for (const file of files) {
    const name = baseName(file);
    if (/^Dockerfile(\..+)?$/.test(name) || /\.dockerfile$/i.test(name)) containers.push({ path: file, kind: 'dockerfile' });
    else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name)) containers.push({ path: file, kind: 'compose' });
    else if (file.startsWith('.devcontainer/') && name === 'devcontainer.json') containers.push({ path: file, kind: 'devcontainer' });
  }
  return containers;
}

export function detectApiSchemas(files: readonly string[], read: ReadFile): RepositoryScan['apiSchemas'] {
  const schemas: RepositoryScan['apiSchemas'] = [];
  for (const file of files) {
    const extension = extensionOf(file);
    const name = baseName(file).toLowerCase();
    if (extension === 'graphql' || extension === 'gql' || extension === 'graphqls') schemas.push({ path: file, kind: 'graphql' });
    else if (extension === 'proto') schemas.push({ path: file, kind: 'protobuf' });
    else if ((extension === 'yaml' || extension === 'yml' || extension === 'json') && /openapi|swagger|api/.test(name)) {
      const head = (read(file) ?? '').slice(0, 4096);
      if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(head)) schemas.push({ path: file, kind: 'openapi' });
    }
  }
  return schemas;
}

/** Migration directories by their conventions; the count is the number of migration files. */
export function detectMigrations(files: readonly string[]): RepositoryScan['migrations'] {
  const rules: ReadonlyArray<[RegExp, string]> = [
    [/(^|\/)prisma\/migrations\//, 'prisma'],
    [/(^|\/)database\/migrations\/[^/]+\.php$/, 'laravel'],
    [/(^|\/)migrations\/\d{4}_[^/]+\.py$/, 'django'],
    [/(^|\/)(alembic|migrations)\/versions\/[^/]+\.py$/, 'alembic'],
    [/(^|\/)db\/migrate\/[^/]+\.rb$/, 'rails'],
    [/(^|\/)db\/migration\/V\d+[^/]*\.sql$/, 'flyway'],
    [/(^|\/)Migrations\/\d{14}_[^/]+\.cs$/, 'ef-core'],
    [/(^|\/)migrations\/[^/]+\.(sql|js|ts|mjs|cjs)$/, 'sql-or-js'],
  ];
  const directories = new Map<string, { kind: string; files: number }>();
  for (const file of files) {
    const rule = rules.find(([pattern]) => pattern.test(file));
    if (rule === undefined) continue;
    // Prisma keeps one folder per migration; everything else keeps its files in one directory.
    const directory = rule[1] === 'prisma' ? file.slice(0, file.indexOf('prisma/migrations/') + 'prisma/migrations'.length) : dirName(file);
    const entry = directories.get(directory) ?? { kind: rule[1], files: 0 };
    entry.files += 1;
    directories.set(directory, entry);
  }
  return [...directories.entries()].map(([path, entry]) => ({ path, kind: entry.kind, files: entry.files })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Everything the scanner reports about one repository. */
export function scanFiles(files: readonly string[], read: ReadFile): RepositoryScan {
  const manifests = detectManifests(files);
  const packageManager = detectPackageManager(files, read);
  return {
    languages: detectLanguages(files),
    manifests,
    packageManager,
    frameworks: detectFrameworks(manifests, read),
    commands: detectCommands(manifests, read, packageManager),
    ci: detectCi(files),
    containers: detectContainers(files),
    apiSchemas: detectApiSchemas(files, read),
    migrations: detectMigrations(files),
  };
}
