import { sql } from 'drizzle-orm'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Form,
  Link,
  NavigationType,
  redirect,
  useFetcher,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router'

import { Celebration } from '~/components/board/celebration'
import { PipelineColumns } from '~/components/board/pipeline-columns'
import { UndoBar } from '~/components/board/undo-bar'
import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { MoneyError, parseUserAmount } from '~/lib/money/money'
import { CelebrationToken } from '~/modules/earnings/celebration'
import { readPipeline, type BoardColumn, type PipelinePayload } from '~/routes/api/board'

import type { Route } from './+types/board'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Pipeline — CRM Leads' }]
}

interface LoaderData extends PipelinePayload {
  readonly lostReasons: ReadonlyArray<{ id: string; label: string }>
  /**
   * Everything the celebration renders, delivered with the board itself.
   *
   * Ruling P2.4: nothing is fetched at T+5,000 ms, so the +/-100 ms window of
   * D3-05 has no network on its render path. Present only for a win that has
   * not been celebrated yet — the `celebrated_at IS NULL` half of "once per
   * opportunity, forever", with the other half enforced by the claim.
   */
  readonly celebration: { opportunityId: string; contactName: string; annualCents: string } | null
}

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  const identity = await requireIdentity(request)
  const justMoved = new URL(request.url).searchParams.get('moved') ?? ''

  const [pipeline, lostReasons, celebration] = await Promise.all([
    readPipeline(request),
    withTenant(identity, async (tx) => {
      const rows = await tx.execute<{ id: string; label: string }>(
        sql`SELECT id, label FROM app.lost_reason
            WHERE tenant_id = app.current_tenant() AND deactivated_at IS NULL
            ORDER BY sort_order`,
      )
      return [...rows]
    }),
    justMoved === ''
      ? Promise.resolve(null)
      : withTenant(identity, async (tx) => {
          // Owner-scoped by the policy AND explicitly, like every other read on
          // this screen: the policy is the floor, not the answer.
          //
          // Bound to `current_stage_type = 'earning'` and never to a stage
          // name. Renaming a column must change nothing here, exactly as it
          // changes nothing at the gate.
          const rows = await tx.execute<{ id: string; name: string; cents: string }>(
            sql`SELECT o.id,
                       coalesce(c.full_name, 'Unnamed lead') AS name,
                       o.premium_annual_cents::text AS cents
                  FROM app.opportunity_live o
                  LEFT JOIN app.contact c
                    ON c.tenant_id = o.tenant_id AND c.id = o.contact_id
                 WHERE o.tenant_id = app.current_tenant()
                   AND o.owner_user_id = app.current_user_id()
                   AND o.id = ${justMoved}::uuid
                   AND o.current_stage_type = 'earning'
                   AND o.celebrated_at IS NULL
                   AND o.premium_annual_cents IS NOT NULL`,
          )
          const row = rows[0]
          return row
            ? { opportunityId: row.id, contactName: row.name, annualCents: row.cents }
            : null
        }),
  ])

  return { ...pipeline, lostReasons, celebration }
}

function field(form: FormData, name: string): string {
  const v = form.get(name)
  return typeof v === 'string' ? v : ''
}

/**
 * Every move goes through `app.stage_move`, including this one. The gate lives
 * in the database, so this action's only job is to turn a raised exception
 * into copy a seller can act on — it cannot let a bad move through even if it
 * tried.
 */
export async function action({ request }: Route.ActionArgs): Promise<Response | { error: string }> {
  const identity = await requireIdentity(request)
  const form = await request.formData()

  const opportunityId = field(form, 'opportunityId')
  const toStageId = field(form, 'toStageId')
  const fromStageId = field(form, 'fromStageId')
  const rawPremium = field(form, 'premium').trim()
  const mode = field(form, 'premiumMode')
  const lostReasonId = field(form, 'lostReasonId')
  // An undo is an ordinary move back through the ordinary gate. The only thing
  // it changes here is what the next screen offers: undoing an undo is a loop,
  // so that redirect carries no bar.
  const isUndo = field(form, 'intent') === 'undo'

  // `moved_via` is audit data, so it is chosen from a closed list rather than
  // passed through. The enum has seven labels — `automation` and `api` among
  // them — and a hand-written POST must not be able to file a seller's own
  // drag as something a machine did. These two are the only ones this screen
  // can honestly produce.
  const via = field(form, 'via') === 'kanban_drag' ? 'kanban_drag' : 'move_sheet'

  let premiumCents: string | null = null
  if (rawPremium !== '') {
    try {
      // Parsed by the money module, which is the only place allowed to turn a
      // human string into cents. It refuses sub-cent precision rather than
      // rounding, because rounding money is a domain decision.
      premiumCents = parseUserAmount(rawPremium).toString()
    } catch (err: unknown) {
      return { error: err instanceof MoneyError ? err.message : 'That amount is not valid.' }
    }
  }

  try {
    await withTenant(identity, (tx) =>
      tx.execute(sql`
        SELECT app.stage_move(
          ${opportunityId}::uuid, ${toStageId}::uuid, ${via}::app.moved_via,
          'human'::app.actor_type, NULL,
          ${premiumCents}::bigint, ${mode === '' ? null : mode}::app.premium_mode,
          ${lostReasonId === '' ? null : lostReasonId}::uuid, NULL)`),
    )
  } catch (err: unknown) {
    // Drizzle wraps the driver error and keeps PostgreSQL's on `cause`, so the
    // code we need is one link down the chain.
    const chain: string[] = []
    let cur: unknown = err
    while (cur instanceof Error) {
      chain.push(cur.message)
      cur = cur.cause
    }
    const text = chain.join(' | ')

    if (text.includes('SM003')) {
      return { error: 'This stage counts toward Earnings. Enter the deal value first.' }
    }
    if (text.includes('SM004')) {
      return { error: 'Choose why this one was lost.' }
    }
    if (text.includes('premium_in_range')) {
      return { error: 'Deal value must be between $1 and $100,000 a year.' }
    }
    if (text.includes('SM404')) {
      // Owner-scoped not-found. Reached by an undo whose card moved underneath
      // it — and never phrased as "you may not", because that confirms the
      // record exists.
      return { error: 'That card is no longer where it was. Nothing changed.' }
    }
    return { error: 'That move could not be saved. Nothing changed.' }
  }

  // Enough to name the move and to walk it back: which card, and which column
  // it came from. No money in the URL, ever — the bar reads the card off the
  // board it just reloaded.
  if (isUndo || fromStageId === '') return redirect('/board')
  return redirect(
    `/board?${new URLSearchParams({ moved: opportunityId, from: fromStageId }).toString()}`,
  )
}

/**
 * The card shown in its new column while the request is still out.
 *
 * COLUMN TOTALS ARE DELIBERATELY LEFT ALONE. Moving the money too would mean
 * the client adding and subtracting cents, which it never does — the totals are
 * summed by the database and arrive with the next loader run. For the tens of
 * milliseconds in between, the card has moved and the totals have not; the card
 * renders at reduced opacity for exactly that reason. A board that is briefly
 * honest about being mid-flight beats one that is briefly wrong about money.
 */
function optimisticallyPlaced(
  columns: readonly BoardColumn[],
  cardId: string | null,
  toStageId: string | null,
): readonly BoardColumn[] {
  if (cardId === null || toStageId === null) return columns

  const card = columns.flatMap((c) => c.cards).find((k) => k.id === cardId)
  if (!card) return columns

  return columns.map((column) => {
    if (column.id === toStageId) {
      return { ...column, cards: [card, ...column.cards.filter((k) => k.id !== cardId)] }
    }
    if (column.cards.some((k) => k.id === cardId)) {
      return { ...column, cards: column.cards.filter((k) => k.id !== cardId) }
    }
    return column
  })
}

export default function Board({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const drag = useFetcher<typeof action>()

  const movingId = params.get('move')
  const moving = loaderData.columns.flatMap((c) => c.cards).find((c) => c.id === movingId)
  const from = loaderData.columns.find((c) => c.cards.some((k) => k.id === movingId))

  // A drop's refusal arrives on the fetcher, not on actionData — different
  // channel, same requirement. `CLAUDE.md`: if the server disagrees with the
  // optimistic state, the card corrects AND a visible message appears. Reading
  // only actionData here would put the correction on screen with no
  // explanation, which is precisely the silent-correction failure.
  const dragError = drag.data && 'error' in drag.data ? drag.data.error : null
  const error = (actionData && 'error' in actionData ? actionData.error : null) ?? dragError

  // Optimistic placement, straight off the in-flight submission. The card sits
  // in its new column while the request is out, and if the server refuses, the
  // next render puts it back — with the message above.
  const pendingCardId = drag.formData ? field(drag.formData, 'opportunityId') || null : null
  const pendingToStageId = drag.formData ? field(drag.formData, 'toStageId') || null : null

  const columns = optimisticallyPlaced(loaderData.columns, pendingCardId, pendingToStageId)

  // The card that just moved, resolved against the board as it is NOW rather
  // than trusted from the URL. A stale link, a card moved in another tab, or a
  // back button lands on `undefined` and offers no undo, instead of offering
  // one that would fail.
  const movedId = params.get('moved')
  const backId = params.get('from')
  const movedTo = movedId
    ? loaderData.columns.find((c) => c.cards.some((k) => k.id === movedId))
    : undefined
  const movedCard = movedTo?.cards.find((k) => k.id === movedId)
  const back = backId ? loaderData.columns.find((c) => c.id === backId) : undefined

  // The celebration, armed only by a MOVE and never by a page load.
  //
  // `useNavigationType()` answers Pop on a fresh document — a reload, a
  // restored tab, a bookmark. The payload survives all three because it is
  // loader data; the confetti does not, and that is US-9.8's "not replayed"
  // obtained structurally rather than by remembering. The wrapping into a
  // CelebrationToken is what stops it being persisted from here on.
  const navigationType = useNavigationType()
  const payload = loaderData.celebration

  // CAPTURED at the moment the window closes, never derived from the live
  // loader payload — and that difference is a defect this had.
  //
  // The claim POSTs through a fetcher, and a fetcher submission revalidates the
  // route. Revalidation re-runs the loader, `celebrated_at` is no longer NULL
  // by then, `celebration` comes back null, and the confetti UNMOUNTED ABOUT
  // TWO HUNDRED MILLISECONDS AFTER IT APPEARED. On screen it was a flash. The
  // e2e assertion had passed because it polled inside that flash.
  //
  // Holding the token in state is also what the ruling means by "lives only in
  // that page's memory": once taken, it does not depend on anything the server
  // says next.
  const [celebrating, setCelebrating] = useState<CelebrationToken | null>(null)

  // The bar's effect must not see a new callback on every render, or it clears
  // and restarts the five seconds it is counting. So what the callback reads
  // lives in a ref, and the callback itself never changes identity.
  const armed = useRef<{ payload: typeof payload; navigationType: typeof navigationType }>({
    payload,
    navigationType,
  })
  useEffect(() => {
    armed.current = { payload, navigationType }
  }, [payload, navigationType])

  const onWindowClosed = useCallback(() => {
    const { payload: p, navigationType: nav } = armed.current
    // `useNavigationType()` answers Pop on a fresh document — a reload, a
    // restored tab, a bookmark. The payload survives all three because it is
    // loader data; the confetti does not, and that is US-9.8's "not replayed"
    // obtained structurally rather than by remembering.
    if (!p || nav === NavigationType.Pop) return
    setCelebrating(new CelebrationToken(p.opportunityId, p.contactName, p.annualCents))
  }, [])
  return (
    <main style={{ padding: 'var(--space-8) var(--space-6)' }}>
      <h1
        style={{
          fontSize: 'var(--type-2xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
          marginBottom: 'var(--space-6)',
        }}
      >
        Pipeline
      </h1>

      {/* A refused move outside the move sheet — an undo, most often — has
          nowhere else to be seen. A card that quietly springs back with no
          message is how a seller learns to distrust the board. */}
      {error && !moving ? (
        <p
          role="alert"
          style={{
            marginBottom: 'var(--space-5)',
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-danger-fill)',
            border: '1px solid var(--color-danger-stroke)',
            color: 'var(--color-danger-text)',
            fontSize: 'var(--type-sm)',
          }}
        >
          {error}
        </p>
      ) : null}

      <PipelineColumns
        columns={columns}
        pendingCardId={pendingCardId}
        onDropCard={(cardId, fromStageId, toStageId) => {
          void drag.submit(
            { opportunityId: cardId, fromStageId, toStageId, via: 'kanban_drag' },
            { method: 'post', action: '/board' },
          )
        }}
        // The gate cannot be satisfied by a drop, so the sheet opens instead of
        // the seller being told no after the fact.
        onNeedsGate={(cardId) => {
          void navigate(`/board?move=${cardId}`)
        }}
      />

      {moving && from ? (
        <MoveSheet
          card={moving}
          fromId={from.id}
          fromName={from.name}
          columns={loaderData.columns}
          lostReasons={loaderData.lostReasons}
          error={error}
        />
      ) : null}

      {/* Keyed by the card, so a second move remounts the bar and restarts the
          window rather than inheriting the remains of the first one. */}
      {movedCard && movedTo && back ? (
        <UndoBar
          key={movedCard.id}
          opportunityId={movedCard.id}
          contactName={movedCard.contactName}
          toStageName={movedTo.name}
          backStageId={back.id}
          backStageName={back.name}
          onWindowClosed={onWindowClosed}
        />
      ) : null}

      {/* One timer, and it is the bar's. Undo or Dismiss unmount the bar, its
          cleanup clears the timeout, and this never renders — which is the
          whole of "no undo was taken in this page session". */}
      {celebrating ? <Celebration token={celebrating} /> : null}
    </main>
  )
}

function MoveSheet({
  card,
  fromId,
  fromName,
  columns,
  lostReasons,
  error,
}: {
  card: { id: string; contactName: string }
  fromId: string
  fromName: string
  columns: readonly BoardColumn[]
  lostReasons: ReadonlyArray<{ id: string; label: string }>
  error: string | null
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-overlay)',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${card.contactName}`}
        style={{
          width: 'min(28rem, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 'var(--space-6)',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--color-border-default)',
        }}
      >
        <h2 style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}>
          Move {card.contactName}
        </h2>
        <p
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Currently in {fromName}
        </p>

        {error ? (
          <p
            role="alert"
            style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-danger-fill)',
              border: '1px solid var(--color-danger-stroke)',
              color: 'var(--color-danger-text)',
              fontSize: 'var(--type-sm)',
            }}
          >
            {error}
          </p>
        ) : null}

        <div style={{ marginTop: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }}>
          {columns
            .filter((c) => !c.cards.some((k) => k.id === card.id))
            .map((target) => (
              <Form
                key={target.id}
                method="post"
                style={{
                  display: 'grid',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-3)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <input type="hidden" name="opportunityId" value={card.id} />
                <input type="hidden" name="toStageId" value={target.id} />
                {/* Where to put the card back, captured before it leaves. */}
                <input type="hidden" name="fromStageId" value={fromId} />

                <strong style={{ fontSize: 'var(--type-sm)' }}>{target.name}</strong>

                {/* The gate, on screen, at the moment it applies. The database
                    refuses this move without a value regardless — this field
                    is how a seller finds that out before being told no. */}
                {target.stageType === 'earning' ? (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input
                      name="premium"
                      inputMode="decimal"
                      placeholder="Deal value"
                      aria-label="Deal value"
                      required
                      style={{
                        flex: 1,
                        padding: 'var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--color-border-default)',
                        fontSize: 'var(--type-sm)',
                      }}
                    />
                    {/* No preselected default: an unchosen mode is how a
                        monthly premium silently becomes an annual one. */}
                    <select
                      name="premiumMode"
                      required
                      defaultValue=""
                      aria-label="Monthly or annual"
                      style={{
                        padding: 'var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--color-border-default)',
                        fontSize: 'var(--type-sm)',
                      }}
                    >
                      <option value="" disabled>
                        Per…
                      </option>
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </div>
                ) : null}

                {target.stageType === 'lost' ? (
                  <select
                    name="lostReasonId"
                    required
                    defaultValue=""
                    aria-label="Reason"
                    style={{
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--color-border-default)',
                      fontSize: 'var(--type-sm)',
                    }}
                  >
                    <option value="" disabled>
                      Why?
                    </option>
                    {lostReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                ) : null}

                <button
                  type="submit"
                  style={{
                    justifySelf: 'start',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    background:
                      target.stageType === 'earning'
                        ? 'var(--color-action-money-bg)'
                        : 'var(--color-action-primary-bg)',
                    color:
                      target.stageType === 'earning'
                        ? 'var(--color-action-money-fg)'
                        : 'var(--color-action-primary-fg)',
                    fontSize: 'var(--type-sm)',
                    fontWeight: 'var(--font-weight-semibold)',
                    cursor: 'pointer',
                  }}
                >
                  Move here
                </button>
              </Form>
            ))}
        </div>

        <Link
          to="/board"
          style={{
            display: 'inline-block',
            marginTop: 'var(--space-5)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Cancel
        </Link>
      </div>
    </div>
  )
}
