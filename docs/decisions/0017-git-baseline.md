# ADR 0017 — Read-only Git baselines, the user's uncommitted work, and Git-based evidence

- **Status:** accepted (M3 step 1, task JRY-0003)
- **Date:** 2026-11-06
- **Affects:** spec §6.2 (Git state, the user's changes), §14.2 (baseline Git: "never assume a clean working
  tree; the user's changes are marked and protected"), §25 (repo changes while a task waits); backlog M3
  "Git baseline snapshot", "Uncommitted changes inventory"; closes gaps from ADR 0013 (resume) and ADR 0014
  (shell-made changes)

## Context

Until now Core never read Git. Report evidence covered only edits made with the file tools, so a file created
by a shell command or a generator was invisible. JERRY did not know which files held the user's own
uncommitted work. A resumed session could not tell whether the repository had moved since its checkpoint.
Hard-rule blocks carried no repository, so repository views (`jerry_list_deviations`, the timeline filter)
missed them.

## Decision

- **Read-only Git reader in Core** (`apps/core/src/git-reader.ts`). JERRY never modifies a repository
  (ADR 0002), `.git` included:
  - every call runs with `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`, so not even
    `git status` refreshes the index, and no hook runs;
  - only reading commands are used: `rev-parse`, `symbolic-ref`, `config --get`, `status --porcelain -z`,
    `diff --name-only`, with no shell and with timeouts;
  - remote URLs are stored without credentials;
  - file contents are never stored, only content hashes.

  A test checks that `.git` stays byte-identical across reads and plan approvals.
- **Baselines** (`git_snapshots`, migration 0008), taken by Core before the transaction:
  - at plan approval: branch, HEAD, upstream, remote, the staged, unstaged and untracked files, and content
    hashes of those files. These are the user's uncommitted work at that moment.
  - at report submission and at checkpoints: the files changed since the plan baseline, with content hashes.

  When Git cannot be read, the reason is stored and Git-based checks say so; nothing is guessed.
- **The user's uncommitted work is protected:**
  - the first time Claude edits, inside the scope, a file that held the user's uncommitted changes at plan
    approval, the gate warns with `monitor.user-uncommitted-file`;
  - the edit is not blocked (ADR 0003), and the warning tells Claude to keep the user's changes;
  - after that first warning (one per file and task, reset when Core restarts or a new plan version is
    approved) the file is quiet;
  - previews (`jerry_check_paths`) show the warning without using it up.
- **Git-based evidence:**
  - the report evidence gains `git`: the files changed since the baseline, also by shell commands or
    generators;
  - a file the user had already changed at baseline counts only if its content changed again (then it is also
    listed as `userChanged`);
  - files Git sees but the report omits are added to `unreportedEdits`.
- **DONE validator.** `code.unchanged-since-report` now also compares content hashes between the report
  snapshot and the moment of acceptance, so a shell change after the report blocks DONE (ADR 0016).
- **Resume.** For each open task shown at SessionStart that has a checkpoint, Core compares HEAD and the
  changed files with the checkpoint snapshot, with a 700 ms budget. When something moved, the start context
  says: `Since then: HEAD moved from abc1234 to def5678, N file(s) changed (check git log and git diff first).`
- **Repository attribution.** Events without a repository (hard-rule blocks, telemetry) get the repository of
  their working directory, so repository views list the blocks too.
- **Visibility.** `GET /api/v1/tasks/:id` and `jerry task show` include the baseline: branch, HEAD, upstream
  and the user's uncommitted files at approval.

## Evidence

- Git reader tests on fixture repositories:
  - staged, unstaged and untracked files;
  - committed changes since a baseline;
  - detached HEAD;
  - a repository without commits;
  - credentials stripped from remotes;
  - `.git` byte-identical across reads.
- Gate tests:
  - the user-file warning inside the scope, and only for that file;
  - out-of-scope edits keep their own warning.
- Integration tests with the bundled bridge and Core:
  - the baseline at approval leaves `.git` untouched;
  - one warning, then silence;
  - a hard-rule block is listed for the repository;
  - a shell-made file and the user's re-changed file appear in the evidence, while the user's unchanged file
    does not;
  - a shell change after the report refuses DONE;
  - after a user commit, the start context says HEAD moved.
- Live (`scripts/e2e-live.mjs`, scenario L):
  - a real session editing the user's uncommitted file got the warning and kept the user's line;
  - a file created by a shell command appears in the report's Git evidence.

## Consequences

- Core needs `git` on PATH for these features. Without it, baselines record the reason, and the rest of JERRY
  works as before.
- Plan approval, report submission and checkpoints each run a few read-only Git commands (tens of
  milliseconds on normal repositories; bounded by timeouts and a 5000-entry status limit).
- Whether editing the user's uncommitted file should be blocked remains the product owner's decision. It would
  be a new hard rule.
