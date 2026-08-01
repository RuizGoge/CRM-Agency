# G0 · US region on the plan we will actually buy

> **Status: ✅ PASS — both halves verified 2026-08-01.**
> The documentation half is confirmed against Render's own current docs; the create-form half was executed against the real dashboard on a Hobby workspace. **The signed stack decision (B2) stands.**

## The assertion under test

From [`docs/05-architecture.md` §9 G0](../05-architecture.md):

> **Assert:** the workspace tier we intend to pay for permits creating web services, background workers **and** Render Postgres in a US region (Ohio or Virginia), confirmed against the provider's own current documentation **and by actually opening the region selector on the create form.**
>
> **Fail:** if US region is not available on that plan, the stack decision is **retroactively void** by the owner's own condition 3.

The gate deliberately demands two independent confirmations. This document closes the first and specifies the second.

## Half 1 — provider documentation · **PASS**

| Question | Finding | Source |
|---|---|---|
| Which regions exist? | Oregon (US), **Ohio (US)**, **Virginia (US)**, Frankfurt, Singapore | [Regions](https://render.com/docs/regions) |
| Is Virginia still early-access? | No — generally available since 2024-08-05 | [Changelog](https://render.com/changelog/virginia-region-us-east-now-generally-available) |
| Does the region field apply to **web services and background workers**? | Yes. Accepted values `oregon` (default), `ohio`, `virginia`, `frankfurt`, `singapore`. Excluded only for static sites. | [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Does the region field apply to **Postgres**? | Yes — same five values, stated for databases explicitly. | [Blueprint spec](https://render.com/docs/blueprint-spec) |
| Is region selection restricted by workspace plan or instance type? | **No restriction is stated anywhere.** Neither the regions page, the workspace-plans page, the platform-features-by-plan page, nor the compute-plans page mentions a region restriction of any kind. | [Regions](https://render.com/docs/regions), [Features by plan](https://render.com/docs/platform-features-by-plan), [Compute plans](https://render.com/docs/compute-plans) |

**Why this is a pass and not a proof.** The blueprint specification is the strongest evidence available on paper, because it is the infrastructure-as-code contract and it enumerates the region enum *per resource type* — services and databases both take all five values, with no plan qualifier. But every statement above is the **absence** of a stated restriction, not the presence of a stated permission. Absence of a documented restriction is exactly the evidence class that produced the contradiction between the two Phase-5 audits in the first place. That is why the gate demands the create form, and why this document does not mark G0 green.

## Half 2 — the create form · ✅ **PASS**

Executed 2026-08-01 against the real Render dashboard, workspace **`My Workspace` on the free (Hobby) plan**, with **no resource created**. Jorge signed in; the three create forms were opened and their selectors read.

| Create form | Region dropdown | Default offered | Verdict |
|---|---|---|---|
| **Web Service** | Ohio (US East) · Oregon (US West) · Frankfurt · Singapore · **Virginia (US East)** | Ohio | ✅ |
| **Background Worker** | **Virginia (US East)** · Oregon · Frankfurt · **Ohio (US East)** · Singapore | Virginia | ✅ |
| **Postgres** | Oregon · Frankfurt · **Ohio (US East)** · Singapore · **Virginia (US East)** | Oregon | ✅ |

**All three resource types offer both Ohio and Virginia on the plan we intend to buy.** The gate's assertion is satisfied and the stack decision is not disturbed.

Three facts observed in passing that the gate did not ask for and that matter anyway:

- **PostgreSQL 18 is offered in the version selector** — the signed stack requires it, and nothing in the corpus had verified it was available rather than assumed.
- **Background Workers have no Free instance type.** The selector starts at Starter. Confirms the docs and the cost model; there is no cheaper rung hiding here.
- The Region field's own helper text states it plainly: *"Your services in the same region can communicate over a private network."* That is the same-region rule of §"Two operational rules" below, in Render's own words on the form where the mistake would be made.

### The original instruction, retained for the record

**Do this before creating any billable resource.** A free-tier probe is enough to read the region selector.

1. Sign in / create the workspace. Confirm the workspace plan shown is **Hobby (free)**.
2. **New → Web Service.** Open the **Region** dropdown. Record: are **Ohio** and **Virginia** both listed and selectable? Screenshot it.
3. On the same form, open the **Instance Type** selector and confirm **Starter** exists and shows its price. Record the price.
4. Back out without creating. **New → Background Worker.** Open the Region dropdown. Record whether Ohio and Virginia are selectable. *(Expect no Free instance type here — background workers are paid-only, which the docs confirm and the cost model already assumes.)*
5. Back out. **New → Postgres.** Open the Region dropdown. Record whether Ohio and Virginia are selectable. Open the plan selector and record the **Basic-1gb** name and price as displayed.
6. Screenshot all three dropdowns.

**Gate verdict rule.** All three resource types must offer Ohio **or** Virginia. If any one of them does not, G0 **fails**, the stack decision is retroactively void, and the runner-up (Rails on DigitalOcean) is signed without debate.

### Two operational rules the create form must respect

Both are new — neither appears anywhere in the Phase-5 corpus, and both are one-way doors:

- **Region cannot be changed after creation.** *"Render doesn't currently support changing the region for an existing service or database."* Picking wrong means destroying and recreating — and for the database, that is the artifact with no recompute path.
- **All four resources must be in the SAME region.** *"services in different regions can't communicate directly over a private network."* A web service in Oregon talking to a Postgres in Ohio would traverse the public internet, carrying ledger rows and lead PII. Pick one region — Ohio or Virginia — and create everything in it.

## Half 3 — the Gate 0-hour cost numbers · ✅ **PASS, every number now read**

The gate ladder hands two pricing facts to "Gate 0-hour" because §9.4.4's self-rising line depends on them. Both are now checked against the primary source, and **the architecture's cost model was right**:

| Number the model assumed | Primary source says | Verdict |
|---|---|---|
| Postgres storage ~$0.30/GiB/month, the only self-rising line | *"$0.30 per GB per month, prorated to the second."* Increasable in multiples of 5 GB. | ✅ confirmed |
| Storage included in the instance price | **None.** Compute and storage are billed separately. §9.4.4 already charges all 20 GB with no free allotment. | ✅ confirmed — the model did not assume an allotment |
| Hobby egress: 5 GB included, $0.15/GB over | 5 GB outbound/month, $0.15/GB additional | ✅ confirmed |
| Postgres backups survive on a Hobby workspace | PITR **3 days on Hobby**, 7 days on Pro+; logical backups retained 7 days *regardless of workspace plan*; neither available on Free instance types | ✅ confirmed — §9.4.2 already wrote "3-day PITR on Hobby" |
| Starter $7.00/mo, Basic-1gb $19.00/mo | **Both exact.** Starter = $7/mo at 512 MB / **0.5 CPU**. Basic-1gb = $19/mo at 1 GB / 0.5 CPU. (Also read: Basic-256mb $6, Basic-4gb $75, Standard $25.) | ✅ confirmed on the form |
| Postgres storage cannot be reduced once grown | The Storage field states it: *"You can increase storage later, but **you can't decrease it**."* Priced live on the form: **15 GB → $4.50/month**, which is $0.30/GB exactly. Specify 1 GB or any multiple of 5 GB. | ✅ confirmed — this is the sentence that makes the R2 archive tier a budget mechanism rather than an optimisation (§9.2.4) |

**The cost model was right on every line.** Two figures were previously unread because render.com/pricing builds its tables client-side; both are now read off the create form and both match what §9.4 assumed. Two collateral confirmations worth keeping: **Starter is 0.5 vCPU, not a core** — the correction G6 already carried for its folded-topology saturation arithmetic — and **the step from Starter to Standard is exactly +$18** ($25 − $7), which is the escape hatch G6 priced in advance.

**The non-negotiable line holds.** Backups are a property of the paid *instance*, not of the Pro *workspace*. A Hobby workspace with a paid Basic Postgres gets 3-day PITR plus exportable logical backups. The `earnings_ledger` is protected on the rung we intend to buy.

**One consequence worth naming.** 3 days of PITR, not 7, is the real recovery window on the plan we will run. G9's timed restore drill inherits that number, and a ledger corruption discovered on day 4 is outside PITR — recoverable only from the hourly R2 dump described in §9.4.2.

## Collateral finding — a stale number in CONTEXT.md

Render replaced its workspace plans on 2026-04-23: **Hobby (free) · Pro $25/month flat · Scale $499/month flat · Enterprise**. Pro **removes per-seat billing** — it replaces the legacy Professional at $19/member.

`docs/05-architecture.md` §9.4.5 was written against this shape and is correct: it prohibits the workspace jump at **$25**, and prices the egress-lift argument at "worth ~$3/month to us, costs $25."

`CONTEXT.md` carries a different figure — a second person with dashboard access "dispara +USD 51 de saltos de plan." That number does not match the architecture (rank 4 in the precedence chain) or the provider's current pricing. **The correct figure is +$25/month flat, after which members are unlimited.** The prohibition in §9.4.5 stands unchanged; only the arithmetic label was stale.

Hobby workspace limits worth carrying forward: **1 member · 25 services · 5 GB egress · 2 custom domains · 500 build minutes/month · 2 environments per project.** The planned topology is 3 services + 1 database, comfortably inside the service cap.
