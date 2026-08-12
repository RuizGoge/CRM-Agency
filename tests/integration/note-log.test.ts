import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { relayOnce } from '~/modules/events/relay'
import { logNoteFor } from '~/routes/api/notes'
import { readTimelineFor } from '~/routes/api/timeline'

import { TEST_URL } from './setup/urls'

/**
 * A SELLER CAN WRITE DOWN WHAT HAPPENED — the second missing writer.
 *
 * `app.activity` has had a schema, three CHECKs, a My Day surface that reads it
 * and a `note` timeline kind waiting for it, and nothing in `app/` ever wrote
 * one. The seed did; the product did not. So the only thing that could ever
 * reach a seller's history was a stage move.
 *
 * ⚠️ `activity.completed` IS THE ONLY EVENT THIS TABLE HAS, and it is about
 * COMPLETING rather than creating. That is the shape of the thing rather than a
 * mismatch: a note is complete the moment it is written. There is no
 * `activity.created` in the canonical 49 and inventing one would be a bug.
 */

const TENANT = '00000000-0000-7000-8000-0000000e1100'
const ANA = '00000000-0000-7000-8000-0000000e11a1'
const BEN = '00000000-0000-7000-8000-0000000e11b1'
const ANAS_CONTACT = '00000000-0000-7000-8000-0000000e11c1'
const BENS_CONTACT = '00000000-0000-7000-8000-0000000e11c2'

let sql: postgres.Sql
const identity = { tenantId: TENANT, userId: ANA }

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Note Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@note.test', 'Ana Note', 'Ana N.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@note.test', 'Ben Note', 'Ben N.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${ANAS_CONTACT}, ${ANA}, 'Ana Lead', 'manual'),
      (${TENANT}, ${BENS_CONTACT}, ${BEN}, 'Ben Lead', 'manual')`
})

afterAll(async () => {
  await sql?.end()
})

describe('logging a note', () => {
  it('writes it complete, owned by the contact’s owner', async () => {
    const result = await logNoteFor(identity, {
      contactId: ANAS_CONTACT,
      body: '  Wants a callback Tuesday.  ',
    })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    const [row] = await sql<
      {
        title: string
        type: string
        owner: string
        completed_by: string | null
        completed_at: Date | null
        created_by: string
      }[]
    >`
      SELECT title, type::text AS type, owner_user_id AS owner,
             completed_by_user_id AS completed_by, completed_at,
             created_by::text AS created_by
        FROM app.activity WHERE tenant_id = ${TENANT} AND id = ${result.activityId}`

    // TRIMMED IN THE DATABASE, not only in the route.
    expect(row?.title).toBe('Wants a callback Tuesday.')
    expect(row?.type).toBe('note')
    expect(row?.created_by).toBe('human')

    // 🔴 THE OWNER IS THE CONTACT'S, THE ACTOR IS THE SESSION'S, and the two are
    // different questions. On the timeline that difference is "You" versus
    // "Handled before this record moved to you".
    expect(row?.owner).toBe(ANA)
    expect(row?.completed_by).toBe(ANA)
    // A note arrives complete — that is what makes `activity.completed` the
    // right event rather than a workaround.
    expect(row?.completed_at).not.toBeNull()
  })

  it('emits activity.completed in the same transaction as the row', async () => {
    // MUTATION: delete the `PERFORM app.event_emit` from the door. The note
    // still saves, My Day still reads it, and the seller's history silently
    // never grows a line. This is the only thing that notices.
    const events = await sql<{ payload: Record<string, unknown>; owner: string }[]>`
      SELECT payload, owner_user_id AS owner FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'activity.completed'`

    expect(events).toHaveLength(1)
    expect(events[0]?.owner).toBe(ANA)
    expect(events[0]?.payload['type']).toBe('note')
    expect(events[0]?.payload['contact_id']).toBe(ANAS_CONTACT)
    expect(events[0]?.payload['auto_completed']).toBe(false)

    // Every declared key present, the nullable ones as JSON null rather than
    // absent — the shape the generated payload type requires.
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      'activity_id',
      'auto_completed',
      'completed_at',
      'completing_event_id',
      'completing_event_name',
      'contact_id',
      'opportunity_id',
      'outcome',
      'type',
    ])
  })

  it('reaches the seller’s history as a line she can read', async () => {
    await relayOnce()

    const page = await readTimelineFor(identity, ANAS_CONTACT, null)
    const notes = page.entries.filter((e) => e.kind === 'note')

    expect(notes).toHaveLength(1)
    expect(notes[0]?.summaryKey).toBe('timeline.kind.note')
    expect(notes[0]?.actorLabelKey).toBe('timeline.actor.you')

    const [dead] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.dead_letter WHERE tenant_id = ${TENANT}`
    expect(dead?.n).toBe(0)
  })

  it('refuses an empty note in the database, not only in the route', async () => {
    // 🔴 `title` IS NOT NULL AND A STRING OF SPACES SATISFIES NOT NULL. Without
    // the guard, a seller tapping Save on an empty box gets a permanent blank
    // line in a history that has no delete. The route validates too; this is the
    // half that survives a caller which forgets.
    //
    // MUTATION: remove the AC002 raise from the door. The route still refuses,
    // every screen still behaves, and the next caller writes the blank line.
    // Context established first, or the tenant guard (AC001) fires before the
    // one under test — which is itself the right ordering and worth noticing.
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT app.begin_request(${TENANT}::uuid, ${ANA}::uuid)`
        await tx`SELECT app.activity_log_note(${ANAS_CONTACT}::uuid, '   ')`
      }),
    ).rejects.toThrow(/AC002/)

    // And the route's own answer, which is the sentence the seller gets.
    expect(await logNoteFor(identity, { contactId: ANAS_CONTACT, body: '   ' })).toEqual({
      status: 'invalid',
      reason: 'empty',
    })
  })

  it('refuses a note past the length limit', async () => {
    expect(await logNoteFor(identity, { contactId: ANAS_CONTACT, body: 'x'.repeat(1001) })).toEqual(
      { status: 'invalid', reason: 'too_long' },
    )
  })

  it('answers a foreign contact, a missing one and a malformed id identically', async () => {
    // OWNER-SCOPED NOT-FOUND, NEVER 403. The door returns NULL for all three.
    const foreign = await logNoteFor(identity, { contactId: BENS_CONTACT, body: 'hello' })
    const missing = await logNoteFor(identity, {
      contactId: '00000000-0000-7000-8000-00000000dead',
      body: 'hello',
    })
    const malformed = await logNoteFor(identity, { contactId: 'not-a-uuid', body: 'hello' })

    expect(foreign).toEqual({ status: 'not_found' })
    expect(missing).toEqual(foreign)
    expect(malformed).toEqual(foreign)

    // And nothing was written into Ben's book.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.activity
       WHERE tenant_id = ${TENANT} AND contact_id = ${BENS_CONTACT}`
    expect(row?.n).toBe(0)
  })
})
