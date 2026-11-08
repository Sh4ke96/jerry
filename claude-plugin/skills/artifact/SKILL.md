---
name: artifact
description: Offer the user an optional Artifact for a finished JERRY task (a stakeholder presentation, the architecture before and after, UI flows, or an endpoint and contract map), create it with Claude only if they want one, and record their choice in JERRY. Use when a JERRY task is DONE, when its plan asked for an Artifact, or when the user asks for one.
model: claude-sonnet-5-5
effort: medium
---

# An optional Artifact for a JERRY task

An Artifact is the user's choice, never automatic. You ask; JERRY records the answer; you create the Artifact
only when the user says yes. It is never written into the repository.

If the user has already said they do not want an Artifact, skip to 3a: record the decline, and do nothing
else.

## 1. Read the task

- Call `get_final_report` with the task ID. Its `artifact.planned` field shows whether the plan already
  asked for an Artifact. Its `artifact.decision` shows whether the user already chose.
- If the task is not DONE yet (`status: draft`), say so. Offer to wait, or to make the Artifact from the
  draft if the user prefers.

## 2. Ask the user

Ask with a question tool, in one message: do they want Claude to create an Artifact for this task, and if so,
which kind:
- **No Artifact**;
- **Stakeholder presentation** of the change;
- **Architecture before and after** (modules and data flows);
- **UI flows and screens**, when the change has a user interface;
- **Endpoint and contract map**, when APIs or contracts changed.

Mention where it will live: an Artifact is a private page in their claude.ai account, which they can share
or delete there. Do not assume an answer, and do not create anything before they answer.

## 3a. No Artifact

Call `record_artifact` with `decision: "declined"` (and their reason, if they gave one). Done.

## 3b. An Artifact

- Build it from the final report's facts only:
  - changes per repository and the diff summary;
  - tests and results;
  - review outcome, risks and open limitations;
  - QA scenarios;
  - Definition of Done evidence.

  Read the changed files when the kind needs them (architecture, endpoints). Never include secrets, tokens,
  personal data or large code dumps.
- Create it with your Artifact capability (in Claude Code: the Artifact tool), with a short title naming the
  task.
- Call `record_artifact` with `decision: "created"`, the kind, the title and the Artifact's link
  (`https://claude.ai/…/artifact/…`). JERRY records only the decision and the link.
- Give the user the link.

If no Artifact capability is available in this session, say so, and record `declined` with that reason only if
the user agrees.

Never write the Artifact or its sources into the repository, and leave Git to the user.
