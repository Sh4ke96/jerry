# ADR 0044 — Security audit of 0.1.0

- **Status:** accepted (M8 step 5, task JRY-0008)
- **Date:** 2026-11-06
- **Affects:** roadmap M8 "Security audit"; hard rules (decisions pending, not changed)

## Decision

- The audit is in [docs/security/audit.md](../security/audit.md): the threat model, thirteen trust
  boundaries, findings with status, and the decisions that belong to the product owner.
- **Fixed in this milestone:** F2 (the CLI warns before running eval cases from a directory other than
  JERRY's own). F3 was already fixed in M7 (plugin evals are never published).
- **Not changed, waiting for the product owner:** the hard-rule changes the audit recommends:
  - F1: guard reads of JERRY's data, the highest finding;
  - F9: extend the user-only commands;
  - reduce the false positives of `hard.core-api` and `hard.git-mutation`.

  Hard rules are changed only with the product owner's explicit approval.
- **Accepted risks:** F6 (Git filters the user configured), F10 (no signing), F11 (one-time login link).
- **Not run:** `pnpm audit`, which needs network access; it is required before a public release.

## Consequences

- Until F1 is decided, an agent that deliberately reads JERRY's token can reach the API indirectly. JERRY's
  hard rules stop naive attempts, and its audit trail records approvals. The protection is not absolute
  against a determined agent with the user's privileges, and the audit says so plainly.
