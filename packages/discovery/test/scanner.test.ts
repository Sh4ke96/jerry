import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectMigrations, scanFiles, scanRepository, walkRepository } from '../src/index.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-discovery-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
/** Builds a fixture tree from { 'path/file': 'content' }. */
function tree(files: Record<string, string>): string {
  counter += 1;
  const root = path.join(base, `t${counter}`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const reader = (files: Record<string, string>) => (relative: string) => files[relative] ?? null;

describe('bounded read-only walker', () => {
  it('skips dependency, build and VCS directories and does not follow links', () => {
    const root = tree({ 'src/a.ts': 'x', 'node_modules/pkg/index.js': 'x', 'dist/a.js': 'x', '.git/HEAD': 'x', 'vendor/lib.php': 'x', 'docs/readme.md': 'x' });
    try {
      fs.symlinkSync(path.join(root, 'src'), path.join(root, 'linked'), 'junction');
    } catch {
      // links may be unavailable; the rest still holds
    }
    const walk = walkRepository(root);
    expect(walk.files.map((file) => file.path)).toEqual(['docs/readme.md', 'src/a.ts']);
    expect(walk.skipped.sort()).toEqual(['.git', 'dist', 'node_modules', 'vendor']);
    expect(walk.truncated).toBe(false);
  });

  it('stops at its limits and says so', () => {
    const root = tree(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`f${index}.txt`, 'x'])));
    const walk = walkRepository(root, { maxFiles: 10 });
    expect(walk.files).toHaveLength(10);
    expect(walk.truncated).toBe(true);
    expect(walkRepository(tree({ 'a/b/c/d.txt': 'x' }), { maxDepth: 1 }).truncated).toBe(true);
  });
});

describe('detectors', () => {
  it('reads a pnpm TypeScript project: manager, frameworks and its own commands', () => {
    const files = {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest run', build: 'vite build', lint: 'eslint .', typecheck: 'tsc', dev: 'vite' }, dependencies: { vue: '3' }, devDependencies: { vite: '8', vitest: '5' } }),
      'pnpm-lock.yaml': '',
      'src/main.ts': '',
      'src/App.vue': '',
    };
    const scan = scanFiles(Object.keys(files), reader(files));
    expect(scan.packageManager).toBe('pnpm');
    expect(scan.manifests).toEqual([{ path: 'package.json', kind: 'npm', lockfile: 'pnpm-lock.yaml' }]);
    expect(scan.frameworks.map((framework) => framework.name).sort()).toEqual(['Vite', 'Vitest', 'Vue']);
    expect(scan.commands.map((command) => `${command.kind}: ${command.command}`)).toEqual(['test: pnpm run test', 'build: pnpm run build', 'lint: pnpm run lint', 'typecheck: pnpm run typecheck']);
    expect(scan.languages).toEqual([{ name: 'TypeScript', files: 1 }, { name: 'Vue', files: 1 }]);
  });

  it('reads PHP, Python, Go, Rust, .NET, Make and nested packages', () => {
    const files = {
      'api/composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' }, 'require-dev': { 'phpunit/phpunit': '^11' }, scripts: { test: 'phpunit' } }),
      'api/composer.lock': '',
      'ml/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.1", "sqlalchemy"]\n[tool.pytest.ini_options]\n[tool.ruff]\n',
      'svc/go.mod': 'module x',
      'svc/go.sum': '',
      'rs/Cargo.toml': '[package]',
      'App.sln': '',
      'web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      Makefile: 'test:\n\tgo test\nlint: build\n\techo\nVAR := 1\n',
    };
    const scan = scanFiles(Object.keys(files), reader(files));
    expect(scan.frameworks.map((framework) => framework.name).sort()).toEqual(['ASP.NET Core', 'FastAPI', 'Laravel', 'PHPUnit', 'SQLAlchemy']);
    const commands = scan.commands.map((command) => command.command);
    expect(commands).toEqual(
      expect.arrayContaining(['composer run test (in api)', 'pytest (in ml)', 'ruff check (in ml)', 'go test ./... (in svc)', 'cargo test (in rs)', 'dotnet test App.sln', 'make test', 'make lint']),
    );
    expect(commands).not.toContain('make VAR');
    expect(scan.manifests.find((manifest) => manifest.path === 'api/composer.json')?.lockfile).toBe('api/composer.lock');
  });

  it('finds CI, containers, API schemas and migrations', () => {
    const files = {
      '.github/workflows/ci.yml': '',
      '.gitlab-ci.yml': '',
      Dockerfile: '',
      'docker-compose.yml': '',
      '.devcontainer/devcontainer.json': '',
      'docs/openapi.yaml': 'openapi: 3.1.0\ninfo: {}',
      'docs/api-notes.yaml': 'title: not a schema',
      'schema.graphql': '',
      'proto/user.proto': '',
      'prisma/migrations/20240101_init/migration.sql': '',
      'prisma/migrations/20240201_add/migration.sql': '',
      'database/migrations/2024_01_01_000000_create_users.php': '',
      'db/migrate/20240101000000_create_users.rb': '',
    };
    const scan = scanFiles(Object.keys(files), reader(files));
    expect(scan.ci.map((entry) => entry.kind).sort()).toEqual(['github-actions', 'gitlab-ci']);
    expect(scan.containers.map((entry) => entry.kind).sort()).toEqual(['compose', 'devcontainer', 'dockerfile']);
    expect(scan.apiSchemas).toEqual([
      { path: 'docs/openapi.yaml', kind: 'openapi' },
      { path: 'schema.graphql', kind: 'graphql' },
      { path: 'proto/user.proto', kind: 'protobuf' },
    ]);
    expect(scan.migrations).toEqual([
      { path: 'database/migrations', kind: 'laravel', files: 1 },
      { path: 'db/migrate', kind: 'rails', files: 1 },
      { path: 'prisma/migrations', kind: 'prisma', files: 2 },
    ]);
  });

  it('groups migration files by directory', () => {
    expect(detectMigrations(['app/migrations/0001_initial.py', 'app/migrations/0002_more.py', 'other/migrations/001.sql'])).toEqual([
      { path: 'app/migrations', kind: 'django', files: 2 },
      { path: 'other/migrations', kind: 'sql-or-js', files: 1 },
    ]);
  });
});

describe('scanRepository', () => {
  it('scans a real tree without writing anything into it', () => {
    const root = tree({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}', 'index.js': '' });
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const scan = scanRepository(root, new Date('2026-11-06T12:00:00.000Z'));
    expect(scan).toMatchObject({ files: 3, truncated: false, packageManager: 'npm', scannedAt: '2026-11-06T12:00:00.000Z' });
    expect(scan.commands).toEqual([{ kind: 'test', command: 'npm run test', source: 'package.json scripts.test' }]);
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });
});
