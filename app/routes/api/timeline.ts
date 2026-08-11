import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
// Type-only, so the schema module is not pulled into this route at runtime —
// the enum is here to make the map below exhaustive, not to query anything.
import type { timelineKind } from '~/db/schema/timeline'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'
import type { GateVerdict } from '~/routes/api/calls'

/**
 * `GET /api/contacts/:contactId/timeline` — the unified per-lead history.
 *
 * MVP item 20's read path. It reads through `app.timeline_read()` and not
 * through the table, and that is not indirection: `crm_app` holds NO privilege
 * on `app.timeline_entry` at all, so the definer is the only door. What the
 * definer withholds is `actor_user_id` — the seller learns "you", "system" or
 * "previous owner" and never a colleague's name, and withholding it in the READ
 * rather than in the component is what makes it true of this API as well as of
 * the screen.
 *
 * KEYSET, NEVER OFFSET. ARR-UX-13: the timeline is the deepest scroll in the
 * product, `timeline_contact_idx` is built (…, occurred_at DESC, id DESC) so the
 * cursor is an index range scan, and an ESLint rule bans Drizzle's `.offset(`
 * across the tree with no exception list.
 */

export type TimelineKind = (typeof timelineKind.enumValues)[number]

/**
 * The summary key per kind, and per blocked verdict.
 *
 * 🔴 `satisfies Record<…>` IS THE MECHANISM, not decoration. A tenth
 * `timeline_kind` label or a seventh `gate_verdict` makes these two literals
 * fail to compile with "missing property", so an entry this API can emit cannot
 * arrive on a screen with no sentence behind it. `TimelineSummaryKey` is derived
 * from them, and the component types its catalog as a TOTAL record of that
 * union — which is the same guarantee reaching the other end of the wire.
 *
 * §11 requires the reason in plain English rather than a code, and the fallback
 * this replaced would have rendered `gate.block.recording_unverified.timeline`
 * to a seller: the verdict existed, the branch did not, and nothing said so.
 */
const KIND_SUMMARY_KEY = {
  call: 'timeline.kind.call',
  message: 'timeline.kind.message',
  note: 'timeline.kind.note',
  meeting: 'timeline.kind.meeting',
  stage_move: 'timeline.kind.stage_move',
  consent: 'timeline.kind.consent',
  send_blocked: 'timeline.kind.send_blocked',
  lead_created: 'timeline.kind.lead_created',
  repost: 'timeline.kind.repost',
} as const satisfies Record<TimelineKind, string>

/**
 * The blocked sentence, per verdict, PER CHANNEL.
 *
 * 🔴 THE CHANNEL SPLIT IS A DEFECT THIS CHANGE CREATED, fixed in the same
 * commit. Before 0060 nothing emitted `compliance.send_blocked`, so the only
 * blocked row a seller could ever see came from a dial and one flat map was
 * honest. The reminder path now emits with `channel = 'sms'` — and a seller
 * whose TEXT was refused outside the calling window would have read "Call not
 * placed". That is a wrong sentence on a seller's screen, which is the one
 * thing this project treats as non-negotiable.
 *
 * Only three verdicts are channel-ambiguous. `blocked_sms_disabled` can only
 * happen on `sms` and `blocked_recording_unverified` only on `call`, so both
 * keep one sentence and it already names the right act.
 */
const BLOCKED_SUMMARY_KEY_CALL = {
  blocked_suppressed: 'gate.block.opted_out.timeline',
  blocked_calling_window: 'gate.block.outside_window.timeline',
  blocked_timezone_unknown: 'gate.block.tz_unknown.timeline',
  blocked_recording_unverified: 'gate.block.recording_paused.timeline',
  blocked_sms_disabled: 'gate.block.channel_off.timeline',
} as const satisfies Record<GateVerdict, string>

const BLOCKED_SUMMARY_KEY_SMS = {
  blocked_suppressed: 'gate.block.opted_out.timeline_sms',
  blocked_calling_window: 'gate.block.outside_window.timeline_sms',
  blocked_timezone_unknown: 'gate.block.tz_unknown.timeline_sms',
  // Unreachable on this channel — the gate requires `call` for it — but the
  // record must be total, and a `satisfies` that skipped a label would be a
  // hole rather than a shortcut.
  blocked_recording_unverified: 'gate.block.recording_paused.timeline',
  blocked_sms_disabled: 'gate.block.channel_off.timeline',
} as const satisfies Record<GateVerdict, string>

export type TimelineSummaryKey =
  | (typeof KIND_SUMMARY_KEY)[TimelineKind]
  | (typeof BLOCKED_SUMMARY_KEY_CALL)[GateVerdict]
  | (typeof BLOCKED_SUMMARY_KEY_SMS)[GateVerdict]

/** What the definer answers instead of a colleague's name. */
export type TimelineActorKey =
  'timeline.actor.you' | 'timeline.actor.system' | 'timeline.actor.previous_owner'

export interface TimelineEntry {
  readonly id: string
  readonly occurredAt: string
  /**
   * The enum label as text, NOT narrowed to `TimelineKind`. Narrowing it would
   * mean casting a column this function cannot vouch for; the two fields the
   * screen renders as words are narrowed instead, which is where it matters.
   */
  readonly kind: string
  readonly summaryKey: TimelineSummaryKey
  readonly actorLabelKey: TimelineActorKey
  readonly payload: Record<string, unknown>
}

export interface TimelinePage {
  readonly entries: readonly TimelineEntry[]
  /** The cursor for the next page, or null when there is no next page. */
  readonly nextCursor: string | null
}

const PAGE = 50

/**
 * The label key for one entry.
 *
 * A KEY AND NOT A SENTENCE. §10.8 and ARR-MVP-28 route every user-facing string
 * through the catalog, and the compliance rows are the reason it matters here:
 * `gate.block.outside_window.timeline` is a blocked string that a snapshot test
 * is allowed to break the build over, because that entry IS the audit record a
 * year later.
 *
 * The two maps are widened to `Map<string, …>` for the LOOKUP only. The literals
 * above stay exhaustive; what arrives here is a text column, and casting it back
 * to the union would assert something about the database that this function is
 * not in a position to know.
 */
const KIND_LOOKUP: ReadonlyMap<string, TimelineSummaryKey> = new Map(
  Object.entries(KIND_SUMMARY_KEY),
)
const BLOCKED_CALL_LOOKUP: ReadonlyMap<string, TimelineSummaryKey> = new Map(
  Object.entries(BLOCKED_SUMMARY_KEY_CALL),
)
const BLOCKED_SMS_LOOKUP: ReadonlyMap<string, TimelineSummaryKey> = new Map(
  Object.entries(BLOCKED_SUMMARY_KEY_SMS),
)

function summaryKeyFor(
  kind: string,
  verdict: string | null,
  payload: Record<string, unknown>,
): TimelineSummaryKey {
  if (kind === 'send_blocked') {
    // The channel comes from the projected payload. A row written before 0060 —
    // or by the writer directly, which the window tests do — carries none, and
    // falls through to the call wording, which is what it always said.
    const lookup = payload['channel'] === 'sms' ? BLOCKED_SMS_LOOKUP : BLOCKED_CALL_LOOKUP
    const blocked = verdict === null ? undefined : lookup.get(verdict)
    return blocked ?? 'timeline.kind.send_blocked'
  }
  return KIND_LOOKUP.get(kind) ?? 'timeline.kind.note'
}

function actorKeyFor(value: string): TimelineActorKey {
  // `previous_owner` is the safe fallback and deliberately so: an unrecognised
  // label must never degrade into something that names a person.
  if (value === 'timeline.actor.you') return 'timeline.actor.you'
  if (value === 'timeline.actor.system') return 'timeline.actor.system'
  return 'timeline.actor.previous_owner'
}

export async function readTimelineFor(
  identity: SessionIdentity,
  contactId: string,
  cursor: string | null,
): Promise<TimelinePage> {
  // The cursor is the pair, encoded together. Both halves or neither: a cursor
  // carrying only a timestamp loses every row that shares its second, and the
  // timeline is the one surface where several things happen inside one.
  const [beforeAt, beforeId] = cursor === null ? [null, null] : cursor.split('|')

  const rows = await withTenant(identity, async (tx) => {
    const result = await tx.execute<{
      id: string
      occurred_at: string
      kind: string
      verdict: string | null
      actor_label_key: string
      render_payload: Record<string, unknown>
    }>(sql`
      SELECT id,
             -- 🔴 MICROSECONDS (US), NOT MILLISECONDS. The first version used MS
             -- and the cursor is this exact string handed back as p_before_at:
             -- an anchor at 12:00:00.123456 truncated to 12:00:00.123 makes the
             -- keyset predicate (occurred_at, id) < (before_at, before_id)
             -- exclude every row between .123000 and .123456 — a silent GAP, on
             -- the deepest scroll in the product, visible only to somebody who
             -- counts. Postgres stores microseconds; the cursor carries them.
             to_char(occurred_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
             kind::text AS kind, verdict::text AS verdict,
             actor_label_key, render_payload
        FROM app.timeline_read(${contactId}::uuid,
                               ${beforeAt ?? null}::timestamptz,
                               ${beforeId ?? null}::uuid,
                               ${PAGE + 1})`)
    return [...result]
  })

  // One more than the page, so "is there another page" is answered by the query
  // rather than by a second count over the same index.
  const hasMore = rows.length > PAGE
  const page = hasMore ? rows.slice(0, PAGE) : rows
  const last = page[page.length - 1]

  return {
    entries: page.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      kind: row.kind,
      summaryKey: summaryKeyFor(row.kind, row.verdict, row.render_payload),
      actorLabelKey: actorKeyFor(row.actor_label_key),
      payload: row.render_payload,
    })),
    nextCursor: hasMore && last !== undefined ? `${last.occurred_at}|${last.id}` : null,
  }
}

export async function loader({
  request,
  params,
}: {
  request: Request
  params: { contactId?: string }
}): Promise<Response> {
  const identity = await requireIdentity(request)
  const contactId = params.contactId

  // A malformed id, another seller's id and an id that never existed are all
  // the same answer. `app.timeline_read` returns an empty stream for a contact
  // it cannot see, so this needs no branch of its own — and having no branch is
  // what makes a 403 impossible to add by accident.
  if (contactId === undefined || !/^[0-9a-f-]{36}$/i.test(contactId)) {
    return Response.json({ entries: [], nextCursor: null } satisfies TimelinePage, {
      headers: { 'cache-control': 'private, no-store' },
    })
  }

  const url = new URL(request.url)
  const page = await readTimelineFor(identity, contactId, url.searchParams.get('cursor'))

  return Response.json(page, { headers: { 'cache-control': 'private, no-store' } })
}

/**
 * The seller's own history of one lead. The deepest scroll in the product.
 */
export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/contacts/:contactId/timeline',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'One contact’s unified history, keyset-paginated, newest first.',
  etag: {
    kind: 'none',
    reason:
      'Opened per navigation and paged forward, never polled. A history page that has been read does not change, and the cursor already makes the next request a different URL.',
  },
  siloProbe: { kind: 'foreign-id', param: 'contactId' },
})
