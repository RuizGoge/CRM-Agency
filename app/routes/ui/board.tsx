import { sql } from 'drizzle-orm'
import { Form, Link, redirect, useSearchParams } from 'react-router'

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
  const rawPremium = field(form, 'premium').trim()
  const mode = field(form, 'premiumMode')
  const lostReasonId = field(form, 'lostReasonId')

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
    return { error: 'That move could not be saved. Nothing changed.' }
  }

  return redirect('/board')
}

export default function Board({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams()
  const movingId = params.get('move')
  const moving = loaderData.columns.flatMap((c) => c.cards).find((c) => c.id === movingId)
  const from = loaderData.columns.find((c) => c.cards.some((k) => k.id === movingId))

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
          fromName={from.name}
          columns={loaderData.columns}
          lostReasons={loaderData.lostReasons}
          error={actionData && 'error' in actionData ? actionData.error : null}
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
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
        <h2 style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}>
          {column.name}
        </h2>
        <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
          {column.cards.length}
        </span>
        {/* Summed by the database. The client never adds money. */}
        {column.totalCents !== '0' ? (
          <span
            className="money"
            style={{
              marginLeft: 'auto',
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
  fromName,
  columns,
  lostReasons,
  error,
}: {
  card: { id: string; contactName: string }
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
