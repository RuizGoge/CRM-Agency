/**
 * A skeleton, never a spinner.
 *
 * A spinner says "something is happening"; a skeleton says "this is what is
 * arriving, and roughly how much of it". On a board a seller checks fifty
 * times a day, the difference is whether the page feels like it is loading or
 * like it is stuck.
 */
export function BoardSkeleton({ rows = 6 }: { rows?: number }): React.JSX.Element {
  return (
    <ul
      aria-hidden="true"
      style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--space-1)' }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: 'var(--space-10) 1fr var(--space-20)',
            alignItems: 'center',
            gap: 'var(--space-4)',
            padding: 'var(--space-3) var(--space-4)',
          }}
        >
          <Bar width="60%" />
          {/* Varying widths, so the placeholder reads as names rather than as a
              loading bar someone forgot to remove. */}
          <Bar width={`${55 + ((i * 13) % 35)}%`} />
          <Bar width="100%" />
        </li>
      ))}
    </ul>
  )
}

function Bar({ width }: { width: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'block',
        width,
        height: 'var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-3)',
      }}
    />
  )
}
