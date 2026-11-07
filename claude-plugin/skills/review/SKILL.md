---
name: review
description: Run JERRY's independent code review of an accepted implementation with the three read-only reviewers, write the fix plan for their findings, make the fixes the user approves, and have the same reviewers re-check. Use when a JERRY task is in code review, review report, fix implementation or re-verification, or when the user asks for the review.
---

# Independent code review with JERRY

When the user accepts an implementation, the task goes to code review. Three read-only reviewers check every
changed file. You orchestrate: you do not review your own work, and you do not decide what is good enough.
Only the user approves fixes or waives the review.

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
- Tell the user it waits for their decision: the dashboard, or
  `jerry approve <taskId> --stage review-fix --version <round>`.
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
