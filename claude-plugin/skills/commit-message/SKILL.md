---
name: commit-message
description: Propose Git commit messages for the current changes, in the repository's own convention, for the user to commit manually. Use when the user asks for a commit message or how to split the changes into commits. It never stages, commits or pushes.
---

# Propose commit messages

The user does every Git operation. Your job is the text: one message, or a split into several commits with a
message each.

## 1. Read the changes (read-only Git only)

- `git status` and `git diff --stat`; then `git diff` (and `git diff --staged` if something is staged) for the
  files that matter. Never run `git add`, `git commit`, `git stash` or anything else that changes Git state;
  JERRY blocks it anyway.
- If the changes belong to a JERRY task, `get_state` gives the task and its plan; an implementation report
  may already propose commit subjects. Use them if they still match the diff.

## 2. Find the convention

- `git log --oneline -30` (and `git log -5 --format=%B` for bodies). Follow what the history does: Conventional
  Commits (`feat(scope): …`), a ticket prefix, plain imperative sentences, language, subject length, body style,
  trailers.
- No clear convention: use Conventional Commits.
- Respect project rules on commits from `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md`.

## 3. Propose

- One logical change per commit. If the diff mixes unrelated changes, propose a split and list the files of
  each commit.
- Subject: imperative, specific, within the convention's length (about 72 characters if none).
- Body: why the change was made and anything a reviewer needs (behaviour changes, migrations, follow-ups),
  wrapped at about 72 characters. No restating of the diff line by line.
- Mention nothing that is not in the diff. If a check failed or did not run, do not claim it passed.

Give each message in a code block, ready to paste. For a split, give the order and the files per commit, as
`git add <files>` lines for the user to run, clearly marked as their commands. Do not run them yourself.
