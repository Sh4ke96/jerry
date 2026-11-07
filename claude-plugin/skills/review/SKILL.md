---
name: review
description: Run JERRY's independent code review of an accepted implementation with the three read-only reviewers, write the fix plan for their findings, make the fixes the user approves, and have the same reviewers re-check. Use when a JERRY task is in code review, review report, fix implementation or re-verification, or when the user asks for the review.
---

# Independent code review with JERRY

Independent review is optional, unless the review mode is `required` (`get_state` → `preferences.reviewMode`,
set by the user globally or per project). The user asks for it when accepting an implementation (the
dashboard, or `jerry approve … --review`), or runs `/jerry:review`; in `required` mode every acceptance goes to
review. An accepted implementation without review goes straight to JERRY's final checks.

A task in code review is checked by three read-only reviewers, on every changed file. You orchestrate: you do
not review your own work, and you do not decide what is good enough. Only the user approves fixes or waives the
review.

## 0. Is the task in review?

- Call `get_state`. Continue only with a task in code review, review report, fix implementation or
  re-verification.
- A task waiting for acceptance is not in review yet: tell the user that they choose review when they accept it
  (dashboard, or `jerry approve <taskId> --stage implementation --version <n> --review`). Never accept it
  yourself.
- A task already accepted without review, or finished, has no review round: say so, and do not start the
  reviewers on it.
- A task that is already in review stays there until the review ends or the user waives it. If the user no
  longer wants it, they finish it with the waiver: "Skip review" in the dashboard, or `jerry review skip <taskId>`.

## 1. Start the round

- Call `get_review` with the task ID. It lists `filesToCover`, the reviewers that have not reported yet,
  and open findings from earlier rounds.
- Start the missing reviewers in parallel, in one message, at most three:
  - `jerry:jerry-correctness-reviewer`;
  - `jerry:jerry-security-reviewer`;
  - `jerry:jerry-design-reviewer`.
- Give each the task ID and tell it to submit with `submit_review`. Do not tell them what to find, and
  do not review the code yourself in their place.
- When all three have reported, JERRY closes the round. If one failed, run it once more. If it fails again,
  `finish_review` closes the round, and the missing reviewer stays visible as a gap.

## 2. Read the result

- `get_review` shows the outcome:
  - no open P1–P3 finding: the review passed and JERRY ran the final checks;
  - otherwise: the open findings, coverage gaps and independence notes.
- Check each finding in the code before planning a fix. If you think one is wrong, say so to the user; only
  the user dismisses findings (dashboard or `jerry findings set`).

## 3. Plan the fixes

- Write the fix plan with `submit_fix_plan`:
  - items, each with the finding IDs it fixes, the change, and its files (inside the approved scope);
  - the tests;
  - `notFixed`, each with the reason.
- Tell the user in one line that it waits for their decision: one click in the dashboard, or
  `jerry approve <taskId> --stage review-fix --version <round>`.
- Do not end your turn. Call `wait_for_decision` (`taskId`, `stage: review-fix`, `version`: the round). It
  waits up to 90 seconds for the user's decision and only reads it:
  - `approved`: continue at once with step 4;
  - `rejected`: read the user's comment (ask if it is empty or unclear), revise the fix plan, submit it again
    with `submit_fix_plan`, and wait again;
  - `pending`: call it again, at most 4 calls in a row (about six minutes). After that, end your turn and
    tell the user you will continue as soon as they decide and write to you.
- Do not change code before the approval. Edits made earlier are deviations, and they keep the task from DONE.

## 4. Fix and re-review

- After the approval, make exactly the planned fixes. Run the project's checks and the targeted tests
  (`list_findings` → `tests.run`).
- Report them with `report_fixes`. JERRY starts the next round for the same three reviewers. Go back
  to step 1.
- After three rounds JERRY stops the automatic loop: tell the user. They waive the review, dismiss findings,
  or send the work back.

## 5. After DONE

Tell the user that the final report is ready (dashboard, `jerry report <taskId>`). Offer the optional
Artifact with `/jerry:artifact`: ask, never assume.

Never accept, approve or waive anything yourself, and never change Git state: the user does all Git
operations.
