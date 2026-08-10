import type { BookChip } from '~/lib/card-health/book-chip'

/**
 * The one status chip. Colour is NEVER the only signal — the label carries the
 * meaning in words, which is WCAG 1.4.1 and also the reason the board's rail
 * pairs a tone with a height.
 */
export function BookChipBadge({ chip }: { readonly chip: BookChip }): React.JSX.Element {
  const tone =
    chip.kind === 'going_cold'
      ? 'var(--color-warning-surface)'
      : chip.kind === 'client'
        ? 'var(--color-success-surface)'
        : 'var(--color-surface-2)'

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        background: tone,
        color: 'var(--color-text)',
        fontSize: 'var(--type-xs)',
        whiteSpace: 'nowrap',
      }}
    >
      {chip.label}
    </span>
  )
}
