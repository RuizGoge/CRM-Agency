import { sql } from 'drizzle-orm'
import { Form, Link, redirect, useSearchParams } from 'react-router'

import { UndoBar } from '~/components/board/undo-bar'
import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { MoneyError, format, fromWireString, parseUserAmount } from '~/lib/money/money'
import { readPipeline, type BoardColumn, type PipelinePayload } from '~/routes/api/board'

import type { Route } from './+types/board'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Pipeline — CRM Leads' }]
}

interface LoaderData extends PipelinePayload {
  readonly lostReasons: ReadonlyArray<{ id: string; label: string }>
}

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  const identity = await requireIdentity(request)
  const [pipeline, lostReasons] = await Promise.all([
    readPipeline(request),
    withTenant(identity, async (tx) => {
      const rows = await tx.execute<{ id: string; label: string }>(
        sql`SELECT id, label FROM app.lost_reason
            WHERE tenant_id = app.current_tenant() AND deactivated_at IS NULL
            ORDER BY sort_order`,
      )
      return [...rows]
    }),
  ])
  return { ...pipeline, lostReasons }
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
          ${opportunityId}::uuid, ${toStageId}::uuid, 'move_sheet'::app.moved_via,
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

export default function Board({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams()
  const movingId = params.get('move')
  const moving = loaderData.columns.flatMap((c) => c.cards).find((c) => c.id === movingId)
  const from = loaderData.columns.find((c) => c.cards.some((k) => k.id === movingId))
  const error = actionData && 'error' in actionData ? actionData.error : null

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

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          overflowX: 'auto',
          paddingBottom: 'var(--space-4)',
        }}
      >
        {loaderData.columns.map((col) => (
          <Column key={col.id} column={col} />
        ))}
      </div>

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
        />
      ) : null}
    </main>
  )
}

function Column({ column }: { column: BoardColumn }): React.JSX.Element {
  const earning = column.stageType === 'earning'

  return (
    <section
      aria-label={column.name}
      style={{
        flex: '0 0 17rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {/* The total sits BELOW the name rather than flush right. Pushed right it
          lands against the next column's heading, and two adjacent columns
          read as one run-on line. */}
      <header style={{ display: 'grid', gap: 'var(--space-1)', minHeight: 'var(--space-10)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <h2 style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}>
            {column.name}
          </h2>
          <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
            {column.cards.length}
          </span>
        </div>

        {/* Summed by the database. The client never adds money. */}
        {column.totalCents !== '0' ? (
          <span
            className="money"
            style={{
              fontSize: 'var(--type-xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: earning ? 'var(--color-success-text)' : 'var(--color-text-secondary)',
            }}
          >
            {format(fromWireString(column.totalCents))}
          </span>
        ) : null}
      </header>

      <div
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          alignContent: 'start',
          minHeight: 'var(--space-16)',
          padding: 'var(--space-2)',
          background: 'var(--color-surface-2)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        {column.cards.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-4) var(--space-2)',
              textAlign: 'center',
              fontSize: 'var(--type-xs)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            Nothing here yet.
          </p>
        ) : (
          column.cards.map((card) => (
            <article
              key={card.id}
              style={{
                padding: 'var(--space-3)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                display: 'grid',
                gap: 'var(--space-2)',
              }}
            >
              <span
                style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}
              >
                {card.contactName}
              </span>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--type-xs)',
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {card.premiumCents ? (
                  <span className="money" style={{ color: 'var(--color-text-secondary)' }}>
                    {format(fromWireString(card.premiumCents))}
                  </span>
                ) : (
                  <span>No value yet</span>
                )}
                <span aria-hidden="true">·</span>
                <span>{card.daysUntouched}d untouched</span>
              </div>

              {card.nextActivity ? (
                <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-secondary)' }}>
                  Next: {card.nextActivity}
                </span>
              ) : (
                <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-caution-text)' }}>
                  No next step
                </span>
              )}

              {/* The universal move path. Drag is bound later and only at
                  >=1024px with a fine pointer, so if it ever fails the product
                  still works from here — on mobile, from the keyboard, and
                  with assistive technology. */}
              <Link
                to={`?move=${card.id}`}
                style={{
                  justifySelf: 'start',
                  fontSize: 'var(--type-xs)',
                  color: 'var(--color-text-link)',
                }}
              >
                Move
              </Link>
            </article>
          ))
        )}
      </div>
    </section>
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
