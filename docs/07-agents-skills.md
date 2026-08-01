# 07 — Agents, Skills and Commands

> **Phase 7 deliverable.** Status: **complete, pending GATE 7.**
> Artifacts live in [`.claude/`](../.claude/). Standards and conventions: [`CLAUDE.md`](../CLAUDE.md).

## The rule this phase was built on

Every artifact here has to justify its existence against a **real, demonstrated failure of this project**. Nothing generic, nothing "because a project usually has one".

And a second filter, which came from the architecture itself: **if a linter or a CI assertion already catches it, an agent that repeats the check is theatre.** The Phase-5 review found that roughly a third of the declared mechanisms in the first architecture draft reduced to "a PR touches that file and nothing else" — an enforcement sentence that presumes a reviewer this project does not have. An agent that merely re-reads what a build already refuses is the same mistake wearing a different hat.

So the test each artifact had to pass was: **does this catch something that is otherwise silent, and does it need judgement?**

---

## Agents

Seven. Four carry judgement and run on a capable model; three are mechanical single-question checks and run on the cheap one.

| Agent | Model | Catches |
|---|---|---|
| [`db-guardian`](../.claude/agents/db-guardian.md) | Opus | The schema defects that are data breaches. Above all a policy with `USING` and no `WITH CHECK` — twelve characters that let a seller write a row owned by someone else, with the write succeeding, the row then invisible to them, and no error raised anywhere. |
| [`security-auditor`](../.claude/agents/security-auditor.md) | Opus | The silo at the route layer and the compliance gates. 403 where not-found is required, a shared cache header on an owner-scoped response, a job payload carrying tenancy, a list endpoint the id-substitution test cannot exercise, a STOP queued behind a bulk backlog. |
| [`precedence-checker`](../.claude/agents/precedence-checker.md) | Sonnet | Work built on text Phase 5 struck. Twelve approved statements were superseded across a ~1.9 MB corpus; reading the older document is this project's single most likely design failure and nothing goes red when it happens. |
| [`ux-reviewer`](../.claude/agents/ux-reviewer.md) | Sonnet | Missing states, click-budget creep, off-system colour, microcopy that dead-ends. None of it is type-checkable and all of it is what makes a CRM feel unfinished. |
| [`event-checker`](../.claude/agents/event-checker.md) | Haiku | An event name outside the canonical 49, a missing envelope field, an unregistered consumer. A Phase-2 audit found 262 event names in use of which 40 were real. |
| [`i18n-checker`](../.claude/agents/i18n-checker.md) | Haiku | Hardcoded user-facing strings, breakpoints and durations. Retrofitting extraction across a finished product is the expensive version of this task. |
| [`context-keeper`](../.claude/agents/context-keeper.md) | Haiku | A session that ends without the record being current. This project's golden rule — that `CLAUDE.md` + `CONTEXT.md` + `docs/` suffice to resume — has already been tested by an agent batch failing mid-phase. |

### Discarded, and why

| Candidate | Verdict |
|---|---|
| `architect-reviewer` | **Replaced.** "Review against the ADRs" is too vague to act on with 92 of them and a six-rank precedence chain. The real, concrete version of that instinct is `precedence-checker`: not *"is this good architecture"* but *"is this built on text that was struck"*. |
| `ui-craftsman` | **Discarded.** An agent that *implements* adds no check. The design-system rules live in `CLAUDE.md` and are enforced by lint and by `ux-reviewer`; a "craftsman" is a wrapper around ordinary work. |
| `test-engineer` | **Converted to a skill.** Turning a Given/When/Then into an executable assertion is a procedure with an order, not a judgement call. It is [`story-to-test`](../.claude/skills/story-to-test/SKILL.md). |
| `perf-checker` | **Discarded, deliberately.** The budgets go to CI and break the build; that *is* the mechanism. An agent that "checks performance" without measuring is exactly the theatre the architecture warns against — and worse, it would report green on the two front-end budgets that are intentionally unset until Sprint-0 Gate 8 measures them. |
| `silo-auditor` | **Folded.** The silo spans schema and routes. Splitting it into a third agent overlapping both would have produced three reviewers of the same property, each assuming another had it covered. It lives in `db-guardian` (schema) and `security-auditor` (routes), and both say so. |

---

## Skills

| Skill | Use it when | Why it earns a procedure |
|---|---|---|
| [`new-endpoint`](../.claude/skills/new-endpoint/SKILL.md) | Any new API surface | The highest-frequency task and the one where a small omission leaks data with no symptom. A hand-written handler outside the factory is invisible to all five registry-driven CI suites. |
| [`new-module`](../.claude/skills/new-module/SKILL.md) | Building out one of the 13 domain modules | Modules share **events, not tables**. Reaching into another module's data is how the silo and the money record get bypassed. |
| [`new-component`](../.claude/skills/new-component/SKILL.md) | Any new UI component | The four states are the component, not decoration. Off-system colour is how a product starts to feel unmade. |
| [`db-migration`](../.claude/skills/db-migration/SKILL.md) | Any schema change | The highest-consequence change type in a system where the database is the enforcer. There are no down migrations — rollback is the previous image, so additive-first is a rule, not a preference. |
| [`story-to-test`](../.claude/skills/story-to-test/SKILL.md) | Starting or finishing a story | 43 acceptance criteria are the Definition of Done. A criterion that never executes is a claim. |
| [`demo-data`](../.claude/skills/demo-data/SKILL.md) | Setting up an environment, or before a demo | Two rehearsals failed on the data, not the software: three sellers make no podium, and the compliance block could not be shown between midday and 5pm Eastern. |
| [`release-check`](../.claude/skills/release-check/SKILL.md) | Before any merge | `npm run verify` proves the code compiles and the tests pass. That is not the same as the work being done. |

### Discarded

**`new-migration-rollback`** — there is no rollback script to write. Rollback is the previous image, so the safety procedure is additive-first and lives inside `db-migration` where it belongs.

---

## Commands

| Command | |
|---|---|
| [`/sprint-status`](../.claude/commands/sprint-status.md) | Phase, what actually landed (from commits, not from the plan), what is blocked and **on whom**, live declared risk, and the next concrete step. |
| [`/handoff`](../.claude/commands/handoff.md) | Pre-existing. Writes a session handoff document. |

---

## Maintenance

These artifacts are part of the conventions they enforce. **If a convention changes, updating the artifact is part of the change** — a `db-guardian` that still checks last month's rules is worse than none, because it produces a green report that means nothing.

Two triggers specifically: when Sprint-0 Gate 8 fixes the bundle and TTI budgets, `release-check` gets the numbers. When a Phase-5 residual risk in §0.3 closes, `precedence-checker` drops it from its list.
