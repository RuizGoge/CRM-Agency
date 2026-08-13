import { useCallback, useEffect, useState } from 'react'

import type { AccessResult } from '~/routes/api/user-access'
import type { RosterResult, TeamMember } from '~/routes/api/users'

import type { Route } from './+types/users-admin'

/**
 * `/admin/users` — who is on the floor, and what they are allowed to do.
 *
 * 🔴 A ROLE IS NOT A MENU SETTING HERE. `app.scope_is_admin()` gates issuing the
 * ingest credential, correcting the public earnings board and reading dead
 * letters — so making somebody an admin on this screen hands them the surfaces
 * that move money. The copy says so before the click, not after.
 *
 * ⚠️ THE PRODUCT STILL CANNOT CREATE A USER. A signable-in account needs a
 * better-auth call and, with no transactional email in the MVP, there is no
 * invitation to send. That is a product decision rather than a missing button,
 * and the screen says it plainly instead of showing an "Add" that fails.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Team — CRM Leads' }]
}

/** No loader: §1.2 sanctions ONE and three exist, so a fourth is refused (`AP005`). */
type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly members: readonly TeamMember[] }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }

const CARD = {
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-5)',
  background: 'var(--color-surface-1)',
} as const

const FIELD = {
  display: 'block',
  marginTop: 'var(--space-2)',
  padding: 'var(--space-2)',
  width: '100%',
  maxWidth: '24rem',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-primary)',
} as const

const ROLE_LABEL: Record<TeamMember['role'], string> = {
  seller: 'Seller',
  supervisor: 'Supervisor',
  admin: 'Admin',
}

export default function UsersAdmin(_: Route.ComponentProps): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [editing, setEditing] = useState<string | null>(null)

  const read = useCallback(async (signal?: AbortSignal): Promise<State> => {
    const response = await fetch('/api/users', {
      ...(signal ? { signal } : {}),
      headers: { accept: 'application/json' },
    })
    if (response.status === 403) return { status: 'forbidden' }
    if (!response.ok) return { status: 'error' }
    const body = (await response.json()) as RosterResult
    return body.status === 'ok'
      ? { status: 'ready', members: body.members }
      : { status: 'forbidden' }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal).then(setState, () => {
      if (!controller.signal.aborted) setState({ status: 'error' })
    })
    return () => {
      controller.abort()
    }
  }, [read])

  const refresh = useCallback(() => {
    void read().then(setState, () => setState({ status: 'error' }))
  }, [read])

  if (state.status === 'loading') {
    return (
      <Shell>
        <div aria-busy="true" aria-live="polite">
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
            Loading the team
          </span>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                ...CARD,
                marginTop: 'var(--space-3)',
                height: '4rem',
                background: 'var(--color-surface-2)',
              }}
            />
          ))}
        </div>
      </Shell>
    )
  }

  if (state.status === 'error') {
    return (
      <Shell>
        <p style={{ ...CARD, color: 'var(--color-text-secondary)' }}>
          We couldn&rsquo;t load the team. Nobody&rsquo;s access has changed.
        </p>
      </Shell>
    )
  }

  if (state.status === 'forbidden') {
    return (
      <Shell>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--type-lg)' }}>
          This page is for admins. Ask your admin if you need someone&rsquo;s access changed.
        </p>
      </Shell>
    )
  }

  // NO EMPTY STATE, and its absence is the argument rather than an omission: an
  // admin is reading this page, so the roster contains at least them. A branch
  // for zero members would be unreachable code pretending to be care.
  return (
    <Shell>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {state.members.map((member) => (
          <li key={member.userId} style={{ ...CARD, marginTop: 'var(--space-3)' }}>
            <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>
              {member.displayName}
              {member.isSelf ? ' · you' : ''}
            </div>
            <p
              style={{
                marginTop: 'var(--space-1)',
                fontSize: 'var(--type-sm)',
                color: 'var(--color-text-tertiary)',
              }}
            >
              {member.email} · {ROLE_LABEL[member.role]}
              {member.active ? '' : ' · no longer has access'}
            </p>

            {editing === member.userId ? (
              <Editor member={member} onDone={refresh} onCancel={() => setEditing(null)} />
            ) : (
              <button
                type="button"
                onClick={() => setEditing(member.userId)}
                style={{ marginTop: 'var(--space-3)' }}
              >
                Change access
              </button>
            )}
          </li>
        ))}
      </ul>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main
      style={{ maxWidth: '52rem', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}
    >
      <h1
        style={{
          fontSize: 'var(--type-3xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
          marginBottom: 'var(--space-3)',
        }}
      >
        Team
      </h1>
      {/* ⚠️ THE STANDING LINE, and it is here because the absence would read as
          a missing feature rather than a decision. */}
      <p style={{ marginBottom: 'var(--space-6)', color: 'var(--color-text-secondary)' }}>
        New people are set up by hand for now — we don&rsquo;t send email yet, so there&rsquo;s no
        invitation to click. This page changes what the people who already have accounts are allowed
        to do.
      </p>
      {children}
    </main>
  )
}

function Editor({
  member,
  onDone,
  onCancel,
}: {
  member: TeamMember
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [role, setRole] = useState<TeamMember['role']>(member.role)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'role' | 'access' | null>(null)

  const post = useCallback(
    async (body: Record<string, string>): Promise<void> => {
      setBusy(true)
      setProblem(null)
      try {
        const response = await fetch('/api/user-access', {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: new URLSearchParams({ userId: member.userId, reason, ...body }),
        })
        const result = (await response.json()) as AccessResult

        if (result.status === 'changed') {
          setConfirming(null)
          onDone()
        } else if (result.status === 'unchanged') {
          setProblem('That was already the case, so nothing changed.')
        } else if (result.status === 'invalid') {
          setProblem(result.reason)
        } else if (result.status === 'not_found') {
          setProblem('That person is no longer on this team. Reload the page.')
        } else {
          setProblem('Only admins can change access.')
        }
      } catch {
        // 🔴 A SILENT FAILURE READS AS "it worked". The server disagreeing must
        // always be visible, and here the thing at stake is somebody's access.
        setProblem('We couldn’t reach the server. Nothing changed.')
      } finally {
        setBusy(false)
      }
    },
    [member.userId, onDone, reason],
  )

  const ready = reason.trim().length >= 10

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      {problem !== null && (
        <p role="alert" style={{ color: 'var(--color-danger-text)' }}>
          {problem}
        </p>
      )}

      <label htmlFor={`role-${member.userId}`} style={{ display: 'block' }}>
        Role
      </label>
      <select
        id={`role-${member.userId}`}
        value={role}
        disabled={busy || member.isSelf}
        onChange={(e) => setRole(e.target.value as TeamMember['role'])}
        style={FIELD}
      >
        {(['seller', 'supervisor', 'admin'] as const).map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {/* The engine refuses both self-changes (UR004 / UR009). Saying so here
          turns a refusal the admin would meet after typing into one they never
          meet at all. */}
      {member.isSelf && (
        <p
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-tertiary)',
          }}
        >
          You can&rsquo;t change your own access — ask another admin.
        </p>
      )}
      {role === 'admin' && member.role !== 'admin' && (
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-caution-text)',
          }}
        >
          Admins can correct the earnings board and change who has access.
        </p>
      )}

      <label
        htmlFor={`reason-${member.userId}`}
        style={{ display: 'block', marginTop: 'var(--space-4)' }}
      >
        Why
      </label>
      <p
        style={{
          marginTop: 'var(--space-1)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Recorded with your name. At least 10 characters.
      </p>
      <textarea
        id={`reason-${member.userId}`}
        value={reason}
        rows={2}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
        style={FIELD}
      />

      {/* A confirm step rather than optimistic-with-undo: this removes or grants
          access to the surfaces that move money, and an undo window is five
          seconds in which the wrong person already has them. */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        {confirming === null ? (
          <>
            {role !== member.role && (
              <button
                type="button"
                disabled={!ready || busy || member.isSelf}
                onClick={() => setConfirming('role')}
              >
                Review role change
              </button>
            )}
            <button
              type="button"
              disabled={!ready || busy || member.isSelf}
              onClick={() => setConfirming('access')}
              style={{ marginLeft: role !== member.role ? 'var(--space-2)' : 0 }}
            >
              {member.active ? 'Remove access' : 'Restore access'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              style={{ marginLeft: 'var(--space-2)' }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <p style={{ fontWeight: 'var(--font-weight-semibold)' }}>
              {confirming === 'role'
                ? `Make ${member.displayName} a ${ROLE_LABEL[role].toLowerCase()}?`
                : member.active
                  ? `Remove ${member.displayName}’s access?`
                  : `Give ${member.displayName} access again?`}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void post(
                  confirming === 'role' ? { role } : { active: member.active ? 'false' : 'true' },
                )
              }
              style={{ marginTop: 'var(--space-3)' }}
            >
              {busy ? 'Saving…' : 'Yes, do it'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(null)}
              style={{ marginTop: 'var(--space-3)', marginLeft: 'var(--space-2)' }}
            >
              Go back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
