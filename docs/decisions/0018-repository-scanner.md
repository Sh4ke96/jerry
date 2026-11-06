# ADR 0018 — Bounded, read-only repository scanner

- **Status:** accepted (M3 step 2, task JRY-0003)
- **Date:** 2026-11-06
- **Affects:** spec §6.2 (what JERRY checks), §7.2 Phase 1 (discovery, project commands); backlog M3
  "Language/framework detectors", "Manifest/lockfile detection", "Existing tests/build/lint detection",
  "API schema detection", "Database migration detection"

## Context

JERRY knew nothing about what a repository is made of. Claude had to rediscover the test command and the stack
in every session, and `/jerry:report` had no reliable list of the checks a project defines.

## Decision

- **New package `packages/discovery`:** a bounded walker plus pure detectors. It has no dependency on Core and
  can be used by the CLI and by Core.
- **The walker only lists and reads; it never runs anything or writes anything.**
  - It does not follow links.
  - It skips VCS, dependency, build, cache and IDE directories: `.git`, `node_modules`, `vendor`, `dist`,
    `build`, `out`, `target`, `obj`, `coverage`, `.next`, `__pycache__`, `.venv` and similar.
  - It stops at 20 000 files or depth 12 and says so (`truncated`).
  - Only small manifests (up to 1 MiB) are read.
- **Detectors:**
  - languages by file extension;
  - manifests with their lockfiles: npm/pnpm/yarn/bun, Composer, Python, Go, Cargo, .NET, Maven, Gradle,
    Ruby, Make;
  - the package manager: the `packageManager` field, then the lockfile;
  - frameworks and test tools from dependencies (for example Vue, React, Next.js, Fastify, NestJS, Laravel,
    Django, FastAPI, Vitest, Jest, Playwright, Prisma, Kysely, ASP.NET Core, Rails, Spring Boot);
  - the project's own commands (test, build, lint, typecheck, format, check) from `package.json` and Composer
    scripts and Make targets, plus well-known conventions for pytest/ruff/mypy, Go, Cargo, .NET, Maven and
    Gradle. Each command carries its source;
  - CI: GitHub Actions, GitLab, Azure, CircleCI, Jenkins, Bitbucket;
  - containers: Dockerfile, compose, devcontainer;
  - API schemas: OpenAPI or Swagger confirmed by the document's header, GraphQL, protobuf;
  - migration directories: Prisma, Laravel, Django, Alembic, Rails, Flyway, EF Core, plain SQL or JS.
- **`jerry repo scan [path] [--json]`** prints the scan. It needs no Core and counts as a read-only command
  for the gate, so Claude may run it without a deviation.

## Evidence

- Walker tests: the skipped directories, links not followed, limits reported.
- Detector tests on fixture trees:
  - a pnpm, Vue and Vite project;
  - a mixed repository with Laravel, FastAPI, Go, Rust, ASP.NET and Make, including nested manifests;
  - CI, containers, API schemas (an OpenAPI file confirmed by its header, a look-alike rejected) and
    migration directories.
- The scan leaves the scanned tree unchanged (unit test and CLI test with a full repository snapshot).
- Gate tests: `jerry repo scan` is read-only; a scan chained with another command is not.
- Real run on JERRY's own repository: pnpm, Fastify, Kysely, Vue, Vite, Vitest, and the build, typecheck,
  test and check scripts.

## Consequences

- Detected commands are shown as the project defines them (`pnpm run test`). Whether the runner is on PATH
  (for example pnpm through corepack) is not checked yet. Step 4 stores the scan in the project profile, and
  the skills will use it.
- Detection is heuristic and reports evidence with every finding, so the user and Claude can judge it.
  Nothing is executed to confirm it.
