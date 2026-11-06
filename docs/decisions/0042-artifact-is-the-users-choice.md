# ADR 0042 — The Artifact is the user's choice, created by Claude

- **Status:** accepted (M8 step 2, task JRY-0008); the product owner's decision of 2026-11-06
- **Date:** 2026-11-06
- **Affects:** spec §7.2 item 16 (optional Artifact), §15.3 (Artifact), Phase 9; roadmap M8 "HTML artifact
  output", "Optional PDF export", "Local artifact browser"
- **Supersedes:** spec §15.3's MVP of locally generated HTML/SVG/PNG/PDF files in `JERRY_HOME/artifacts`, and
  plan v1 of M8, which had Core render an HTML artifact for every DONE task.

## Context

The product owner corrected M8 plan v1. An Artifact is an option the user picks through a JERRY skill. Claude
creates it only when the user wants one.

## Decision

- **Asking is the skill's job.** `/jerry:artifact` reads the task's final report, then asks the user whether
  they want Claude to create an Artifact, and which kind:
  - a stakeholder presentation;
  - the architecture before and after;
  - UI flows and screens;
  - an endpoint and contract map.

  `/jerry:plan` asks the same question up front and records the answer in the plan's `artifact` field.
  `/jerry:review` points to `/jerry:artifact` after DONE.
- **On "no"**, nothing is created, and the skill records `declined` (with the reason, if given).
- **On "yes"**, Claude builds the Artifact with its own Artifact capability (in Claude Code, the Artifact tool;
  a private page in the user's claude.ai account). It uses the final report's facts, never secrets or large
  code dumps. The skill then records `created` with the kind, title and link.
- **JERRY stores the decision, never the Artifact.**
  - Migration 0017 adds `artifact_decisions`.
  - `jerry_record_artifact` accepts only `https://claude.ai/…/artifact/…` links.
  - The latest decision of a task counts.
  - Nothing is written to `JERRY_HOME/artifacts` or into a repository.
- **Visibility.** The final report has an Artifact section (planned, created with its link, declined, or not
  asked yet). The dashboard shows a link on the task card and an Artifacts list; both validate links again.
- **Roadmap items:**
  - "HTML artifact output" and "Local artifact browser" are met by the user-chosen Artifact and the Artifacts
    list.
  - "Optional PDF export" is superseded: Claude's Artifact types handle exports (a deck downloads as PDF or
    PPTX), and JERRY renders nothing itself.

## Consequences

- No Artifact exists without an explicit yes. The user owns it in their claude.ai account and can share or
  delete it there.
- Headless sessions cannot answer the question tool, so the live check covers the "no" path, with the answer
  given in the prompt. Creating a real Artifact is left to an interactive session, because it publishes to the
  user's account.
