# QA scenarios in a JERRY implementation report

Each QA scenario has `id` (QA-1, QA-2…), `priority` (P1 / P2 / P3), `title`, `location` (screen,
UI path, endpoint or command), `roles`, `preconditions`, `testData`, `steps`, `expected`, `negative` (what must
not happen, or the negative variant), `related` (API calls or events), and `kind` (new / regression). Cover the
main path, the error paths and at least one regression scenario for what could break nearby.

Write the human text of the QA scenarios (`title`, `preconditions`, `testData`, `steps`, `expected`,
`negative`) in the QA language: Polish for `pl` (the default), English for `en`. Set `qaLanguage` to that
language. Field names, IDs, priorities, `kind`, paths, commands, UI labels and code stay as they are, and every
other field of the report stays in English.
