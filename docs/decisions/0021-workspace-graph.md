# ADR 0021 — Links between repositories

- **Status:** accepted (M3 step 5, task JRY-0003)
- **Date:** 2026-11-06
- **Affects:** spec §6.2 (dependencies between repositories), §14.1 (workspace model: contract provider →
  consumers, shared library → dependents, generated clients); backlog M3 "Multi-repo workspace graph"

## Context

A change in an API repository can break the web and admin repositories that consume it. JERRY kept a profile
per repository (ADR 0020) but did not know how repositories relate. Plans for multi-repository changes
(spec §14.1) need that map.

## Decision

- **The scan records package identity per manifest:**
  - the published name (npm name, Composer name, Go module path, crate, Python project);
  - the dependencies;
  - dependencies given as relative paths: npm `file:`, `link:` or `portal:`, Composer `path` repositories,
    Go `replace … => ../x`, Cargo or Poetry `path =`.
- **Contract references.** The scan records schema files (OpenAPI YAML/JSON, GraphQL, proto) that
  code-generation configs take from outside the repository:
  - configs read: `package.json` scripts, `openapitools.json`, `nswag.json`, `orval.config.*`,
    `openapi-ts.config.*`, `codegen.yml`, `.graphqlrc`, `buf.gen.yaml`;
  - only paths that leave the repository (`../…`) count.
- **The graph** (`buildWorkspaceGraph`, a pure function over the profiles of known repositories). An edge
  points from the dependent to the repository it depends on, and always carries its evidence:
  - `local-path`: a relative path dependency resolves inside another known repository (the deepest root
    wins);
  - `package`: a dependency's name is published by another known repository;
  - `api-contract`: a code-generation config points at a file in another repository; the evidence says
    whether that file is one of its detected API schemas.

  A repository is never linked to itself, and paths outside known repositories are ignored.
- **Known repositories** are the ones JERRY has profiles for: a Claude Code session started there, or they were
  scanned. The graph is built from cached profiles only, without scanning.
  - Profiles gained a format version (2). Profiles stored by an older JERRY count as stale (`format`) and are
    rescanned.
- **Surfaces:**
  - `GET /api/v1/workspace/graph`;
  - `jerry repo graph [--json]`, read-only for the gate;
  - the dashboard's Repositories view: "Links between repositories" with the evidence;
  - `jerry_get_project_profile` adds `relatedRepositories` ("depends on …" and "used by …") for the
    repository asked about.

## Evidence

- Unit tests:
  - package identity for npm, Composer, Go, Cargo and Python, including local path dependencies;
  - contract references from four config styles, with non-config files ignored;
  - a five-repository workspace yields exactly the local-path, package and API-contract edges with their
    evidence;
  - no self-links, and no links to unknown paths.
- Integration test with the bundled Core and MCP server: two scanned repositories get all three edge kinds,
  and the MCP profile names the related repository.
- Dashboard test: the links section with its evidence.

## Consequences

- The graph only covers repositories JERRY has seen. A dependency on a repository never opened with Claude
  Code appears once it is scanned (`jerry repo profile <path>`).
- Plan synthesis for multi-repository tasks (M4) can use the graph to order contract changes before their
  consumers.
