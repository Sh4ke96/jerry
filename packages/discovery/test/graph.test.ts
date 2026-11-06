import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWorkspaceGraph, detectContractReferences, detectPackages, scanRepository, type GraphInput } from '../src/index.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-graph-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const root = path.join(base, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const asInput = (root: string): GraphInput => {
  const scan = scanRepository(root);
  return { repoRoot: root, names: scan.packages.map((pkg) => pkg.name).filter((name): name is string => name !== null), apiSchemas: scan.apiSchemas.map((schema) => schema.path), packages: scan.packages, contractReferences: scan.contractReferences };
};

describe('package identity per ecosystem', () => {
  it('reads names, dependencies and local path dependencies', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: '@shop/web', dependencies: { '@shop/ui': 'file:../ui', vue: '3' }, devDependencies: { '@shop/types': 'workspace:*' } }),
      'composer.json': JSON.stringify({ name: 'shop/api', require: { 'shop/core': '*' }, repositories: [{ type: 'path', url: '../core' }] }),
      'go.mod': 'module example.com/shop/svc\n\nrequire (\n\texample.com/shop/lib v1.2.0\n)\n\nreplace example.com/shop/lib => ../lib\n',
      'Cargo.toml': '[package]\nname = "shop-engine"\n\n[dependencies]\nshop-core = { path = "../core" }\nserde = "1"\n',
      'pyproject.toml': '[project]\nname = "shop-ml"\ndependencies = ["shop-sdk", "numpy>=1"]\n',
    };
    const manifests = [
      { path: 'package.json', kind: 'npm' },
      { path: 'composer.json', kind: 'composer' },
      { path: 'go.mod', kind: 'go' },
      { path: 'Cargo.toml', kind: 'cargo' },
      { path: 'pyproject.toml', kind: 'python' },
    ];
    const packages = detectPackages(manifests, (file) => files[file] ?? null);
    expect(packages.map((pkg) => [pkg.ecosystem, pkg.name, pkg.localPaths])).toEqual([
      ['npm', '@shop/web', ['../ui']],
      ['composer', 'shop/api', ['../core']],
      ['go', 'example.com/shop/svc', ['../lib']],
      ['cargo', 'shop-engine', ['../core']],
      ['python', 'shop-ml', []],
    ]);
    expect(packages[0]?.dependencies).toEqual(['@shop/ui', 'vue', '@shop/types']);
    expect(packages[2]?.dependencies).toEqual(['example.com/shop/lib']);
    expect(packages[3]?.dependencies).toEqual(['shop-core', 'serde']);
    expect(packages[4]?.dependencies).toEqual(['shop-sdk', 'numpy']);
  });

  it('finds schema paths that code-generation configs take from outside the repository', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: { 'gen:api': 'openapi-generator-cli generate -i ../api/openapi.yaml -g typescript-fetch' } }),
      'orval.config.ts': "export default { shop: { input: '../api/openapi.yaml' } };",
      'codegen.yml': 'schema: ../graph/schema.graphql',
      'src/readme.md': '../not-a-config.yaml',
    };
    expect(detectContractReferences(Object.keys(files), (file) => files[file] ?? null)).toEqual([
      { source: 'package.json', target: '../api/openapi.yaml' },
      { source: 'orval.config.ts', target: '../api/openapi.yaml' },
      { source: 'codegen.yml', target: '../graph/schema.graphql' },
    ]);
  });
});

describe('workspace graph', () => {
  it('links consumers to providers by local path, package name and API contract, with evidence', () => {
    const api = repo('api', { 'composer.json': JSON.stringify({ name: 'shop/api' }), 'docs/openapi.yaml': 'openapi: 3.1.0' });
    const ui = repo('ui', { 'package.json': JSON.stringify({ name: '@shop/ui' }) });
    const web = repo('web', {
      'package.json': JSON.stringify({ name: '@shop/web', dependencies: { '@shop/ui': 'file:../ui' }, scripts: { gen: 'orval --input ../api/docs/openapi.yaml' } }),
    });
    const admin = repo('admin', { 'package.json': JSON.stringify({ name: '@shop/admin', dependencies: { '@shop/ui': '^1.0.0' } }) });
    const lonely = repo('lonely', { 'package.json': JSON.stringify({ name: 'lonely', dependencies: { lodash: '4' } }) });

    const graph = buildWorkspaceGraph([api, ui, web, admin, lonely].map(asInput));
    const edges = graph.edges.map((edge) => `${path.basename(edge.from)} -> ${path.basename(edge.to)} [${edge.kind}] ${edge.evidence}`);
    expect(edges).toEqual([
      'web -> ui [local-path] package.json → ../ui',
      'web -> ui [package] package.json depends on @shop/ui',
      'web -> api [api-contract] package.json uses API schema docs/openapi.yaml',
      'admin -> ui [package] package.json depends on @shop/ui',
    ]);
    expect(graph.nodes.find((node) => node.repoRoot === api)).toMatchObject({ names: ['shop/api'], apiSchemas: ['docs/openapi.yaml'] });
  });

  it('never links a repository to itself or to paths outside known repositories', () => {
    const self = repo('self', { 'package.json': JSON.stringify({ name: 'self', dependencies: { self: 'file:./' , other: 'file:../unknown' } }) });
    expect(buildWorkspaceGraph([asInput(self)]).edges).toEqual([]);
  });
});
