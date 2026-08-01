---
name: release-check
description: Pre-merge gate. Runs the automated pipeline and then checks the Definition-of-Done items that no command can check. Use before merging any change and before closing a sprint item. Exists because `npm run verify` proves the code compiles and the tests pass, which is not the same as the work being done.
---

# Release check

## 1 · The automated half

```bash
npm run verify        # typecheck + lint + format + tests
npm run test:e2e      # if any UI changed
```

Green is the entry condition, not the finish line. Everything below is what the pipeline cannot see.

## 2 · The half a command cannot check

**States.** Every new surface renders empty, loading, error and no-permission. Open each one; do not infer it from the code.

**Permissions.** Enforced server-side. A hidden button is not enforcement. Verify by calling the endpoint directly as the wrong role.

**The silo.** Every new record-bearing endpoint has its second-session assertion. Every list endpoint that takes no id has a two-seller fixture asserting zero rows.

**Money.** No monetary value typed as a number anywhere. Every amount that crosses JSON is a string of whole cents. Every money mutation appends to the ledger in the same transaction as the write that caused it.

**Events.** Only canonical names, consumers registered, correct tier. Run `event-checker`.

**Microcopy.** en-US, action-oriented. Any blocked action says what is still enforced and offers the legal alternative one tap away.

**Protected assertions.** None of the ten is skipped. A skipped protected assertion means the item is not done, whatever the board says.

**Precedence.** If the change implements something specified in a Phase 2–4 document, run `precedence-checker`. Twelve approved statements were struck and reading the older text is this project's most likely design failure.

## 3 · The budgets, honestly

API p95 under 300 ms · search under 200 ms · LCP under 1.5 s with 500 leads · drag at 60 fps with no long task over 50 ms.

The front-end bundle and TTI budgets are deliberately unset until Sprint-0 Gate 8 measures them. **Do not set a number to make a build pass** — weakening a budget to go green is the exact failure this whole design exists to prevent, and it is invisible afterwards.

## 4 · The record

`CONTEXT.md` reflects any decision taken. Run `context-keeper`.

## Output

A short report: what passed, what failed, and what is **not done** — with the distinction between "failing" and "not built" made explicit. Never report done when a protected assertion is skipped or a state is missing.
