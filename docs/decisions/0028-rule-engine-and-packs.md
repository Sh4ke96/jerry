# ADR 0028 — Static rule engine and the first rule packs

- **Status:** accepted (M5 step 2, task JRY-0005)
- **Date:** 2026-11-06
- **Affects:** spec §2.1 (Harry-inspired rules: id, languages, severity, examples, exceptions, version;
  project conventions win), §12.1–12.2 (categories), §13.4 (deterministic graders first); roadmap M5 "Static
  rule engine", "Harry-like naming/prose pack", "Error-handling pack", "Test-quality pack", "Security check
  interface"

## Decision

- **New package `@jerry/quality`.** Pure: no file system, no processes. Core reads the files (read-only) and
  passes their content plus the changed line numbers. Only hits on changed lines become findings (spec §2.1:
  the diff, not the repository).
- **A rule** has:
  - an ID and a semantic version;
  - category, source and severity P1–P4;
  - confidence;
  - languages, and the files it applies to (test files only, code only, or all);
  - title, why it matters, suggested fix;
  - positive and negative examples, which are also its unit tests;
  - documented exceptions.
- **Packs:**
  - **Naming and prose** (Harry-inspired):
    - commented-out code;
    - vague names (`data`, `temp`, `tmp`, `obj`, …);
    - booleans that do not say what is true;
    - time values without a unit, only where the file already names units (the project convention);
    - empty or vague TODOs;
    - error messages without context;
    - comments that repeat the next line.
  - **Error handling:**
    - empty catch (P2), unless a comment inside explains why;
    - catch that only logs;
    - `.catch(() => {})` (a fallback value such as `.catch(() => null)` is allowed).
  - **Test quality:**
    - `.only` and `.skip`;
    - weak test names;
    - tests without an assertion (helpers named `expect…`, `assert…`, `check…` and `verify…` count as
      assertions).
  - **Security:**
    - `eval` and `new Function`;
    - shell commands built from strings;
    - unescaped HTML;
    - TLS verification off;
    - hard-coded secrets (the value is masked in the evidence, example secrets are built from fragments);
    - private key blocks.
- **Security check interface.** `SecurityScanner { name, scan(files) }`. The built-in pack implements it; an
  external SAST tool the user installs can be plugged in later behind the same interface.
- **Calibration on real code.** Before shipping, the rules ran on JERRY's own 126 source files. The first
  version produced 57 hits, mostly idiomatic `result`/`info`, prose comments ending with `;`, deliberate
  `.catch(() => null)` fallbacks and assertion helpers. After calibration it produces 4, each defensible.
  Each calibration became a negative example.
- **Language support.** TypeScript and JavaScript fully; Python for most rules; PHP, Java, C#, Go and Ruby for
  the text-based rules. Other files are only checked by language-independent rules (TODOs, secrets).

## Consequences

- AI semantic graders (spec §12.1) can be added later behind the same finding model, with calibration against
  human labels (spec §13.4).
- False positives remain possible. The user's FALSE_POSITIVE decisions mute a rule (ADR 0027), and every fix
  to a rule adds a negative example.
