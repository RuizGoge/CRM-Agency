import { useCallback, useState } from 'react'

import type { LogNoteResult } from '~/routes/api/notes'

/**
 * The note composer — where a seller writes down what happened.
 *
 * 🔴 IT SITS ABOVE THE HISTORY, NOT BELOW IT. The Activity region is reverse
 * chronological, so the newest line is at the top; a composer under the list
 * would mean typing at one end and watching the result appear at the other.
 *
 * ⚠️ NO OPTIMISTIC ROW AND NO UNDO, deliberately. The 5-second undo is for
 * moves, where the server holds the row and can walk it back. A note has no id
 * until the server answers, and there is no delete — so rendering it early
 * would mean showing a seller a permanent line that might not exist. The
 * honest shape is: disabled while saving, then the history reloads.
 */

const MAX_BODY = 1000

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  /** Written, and waiting for the projector to turn it into a line. */
  | { readonly status: 'saved' }
  | { readonly status: 'error' }
  | { readonly status: 'not_found' }

/**
 * 🔴 THE HISTORY IS A PROJECTION, SO IT ARRIVES LATE — and the first version of
 * this component did not account for it. The note commits, the box clears, and
 * the relay turns the event into a timeline row on its next tick. Reloading the
 * history the instant the POST returns therefore redraws the OLD list: the
 * seller saves, sees nothing change, and concludes it was lost. Measured on
 * screen, which is the only place it was ever going to show up.
 *
 * The relay's floor is 1000 ms (`app/jobs/worker.ts`), so this waits past it.
 *
 * ⚠️ AND THAT IS A TIMING ASSUMPTION, NOT A GUARANTEE. A slow tick still redraws
 * a history without the new line — which is why the confirmation below stays on
 * screen rather than the reload being treated as the confirmation. The seller is
 * told the note saved by something that knows it saved, not by a line appearing.
 */
const PROJECTION_GRACE_MS = 1600

export function NoteComposer({
  contactId,
  onLogged,
}: {
  contactId: string
  onLogged: () => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [state, setState] = useState<State>({ status: 'idle' })

  const trimmed = body.trim()
  const tooLong = body.length > MAX_BODY
  const canSave = trimmed !== '' && !tooLong && state.status !== 'saving'

  const save = useCallback(async () => {
    setState({ status: 'saving' })
    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        body: new URLSearchParams({ contactId, body: trimmed }),
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) {
        setState({ status: 'not_found' })
        return
      }
      if (!response.ok) {
        setState({ status: 'error' })
        return
      }
      const result = (await response.json()) as LogNoteResult
      if (result.status !== 'created') {
        setState({ status: 'error' })
        return
      }
      setBody('')
      setState({ status: 'saved' })
      window.setTimeout(onLogged, PROJECTION_GRACE_MS)
    } catch {
      setState({ status: 'error' })
    }
  }, [contactId, trimmed, onLogged])

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <label
        htmlFor="note-body"
        style={{
          display: 'block',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-secondary)',
        }}
      >
        Add a note
      </label>

      <textarea
        id="note-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="What happened?"
        style={{
          width: '100%',
          marginTop: 'var(--space-1)',
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--type-sm)',
          fontFamily: 'inherit',
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${
            tooLong ? 'var(--color-danger-stroke)' : 'var(--color-border-default)'
          }`,
          background: 'var(--color-surface-1)',
          color: 'var(--color-text-primary)',
          resize: 'vertical',
        }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          marginTop: 'var(--space-2)',
        }}
      >
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          style={{
            minHeight: 'var(--size-target-min)',
            padding: 'var(--space-2) var(--space-4)',
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-medium)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-action-secondary-border)',
            background: canSave
              ? 'var(--color-action-primary-bg)'
              : 'var(--color-action-disabled-bg)',
            color: canSave ? 'var(--color-action-primary-fg)' : 'var(--color-action-disabled-fg)',
          }}
        >
          {state.status === 'saving' ? 'Saving…' : 'Save note'}
        </button>

        {/* The count appears only when it starts to matter. A counter on an
            empty box is noise; a counter at 900 characters is a warning. */}
        {body.length > MAX_BODY - 200 ? (
          <span
            style={{
              fontSize: 'var(--type-sm)',
              color: tooLong ? 'var(--color-danger-text)' : 'var(--color-text-tertiary)',
            }}
          >
            {body.length} / {MAX_BODY}
          </span>
        ) : null}
      </div>

      {/* 🔴 SAID BY SOMETHING THAT KNOWS. The line appearing is not the
          confirmation — it arrives a tick later and might not arrive at all if
          the relay is slow. This is. */}
      {state.status === 'saved' ? (
        <p
          role="status"
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Saved. It’ll appear in the history in a moment.
        </p>
      ) : null}

      {/* 🔴 A VISIBLE FAILURE, ALWAYS. A note that silently does not save is how
          a seller loses what a lead told them and never finds out. */}
      {state.status === 'error' ? (
        <p
          role="status"
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          That didn’t save. Your text is still here — try again.
        </p>
      ) : null}

      {state.status === 'not_found' ? (
        <p
          role="status"
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          That contact isn’t in your book any more.
        </p>
      ) : null}
    </div>
  )
}
