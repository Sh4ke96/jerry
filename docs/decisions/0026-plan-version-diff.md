# ADR 0026 — Plan version diff in the dashboard and `jerry plan diff`

- **Status:** accepted (M4 step 5, task JRY-0004)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 3 ("each correction creates a new plan version"; approval binds to
  `plan_version` and `content_hash`), ADR 0011 (plans submitted by Claude), ADR 0024 (an intake becomes a
  plan); roadmap M4 "Plan version diff UI"

## Context

Every plan revision voids the earlier approval, so the user has to review it again. Before this change the
dashboard showed only the current version, and the user had to re-read the whole plan to find what Claude
changed. This includes the scope that JERRY checks edits against.

## Decision

- **Versions.** `GET /api/v1/tasks/:taskId/plans` (token or dashboard session, read-only) returns every
  stored plan version, oldest first. Core already kept all of them.
- **Diff.** `diffPlans(older, newer)` in `@jerry/workflow` is pure and browser-safe, so the dashboard and the
  CLI compute it locally. It returns:
  - **scope:** globs added and removed, shown first because they decide which edits count as planned;
  - **document:** `added` when a scope-only plan or intake became a full plan, `removed` for the reverse;
  - **text sections** (goal, current state, architecture impact, cross-repository dependencies, rollback,
    regression, artifact): the old and the new text;
  - **list sections** (classification, repositories, changes, risks, out of scope, steps, tests, commits, QA,
    Definition of Done, open questions, analysis reports and gaps): items added and removed, one readable
    line per item, compared as multisets. A changed item shows as one removed and one added line.
- **Dashboard.** A task card whose plan has more than one version offers "Changes since v{n−1}".
  - Added lines are green with "+"; removed lines are red, struck through, with "−".
  - Screen readers hear "added" or "removed".
- **CLI.** `jerry plan diff <taskId> [--from n] [--to m]` compares the latest version with the one before by
  default. It prints `+` and `-` lines per section and exits 1 for an invalid pair.
- No MCP tool: Claude wrote the revisions and has them; the diff is for the user's review.

## Evidence

- Unit tests:
  - identical versions give an empty diff;
  - scope, text and list changes are reported;
  - an intake becoming a plan with cited analysis is shown;
  - duplicate items and scope-only versions are compared correctly.
- Dashboard test: the button appears only for revised plans, the diff loads on demand and hides again, and
  added and removed lines are marked.
- CLI integration test: nothing to compare at v1; latest against previous; `--from`/`--to`; an invalid pair is
  refused.

## Consequences

- Reordering steps shows as removed and added lines, because the comparison is by content, not position.
  That is acceptable: renumbered dependencies change what the steps mean anyway.
