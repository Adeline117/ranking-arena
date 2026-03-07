import { tokens } from '@/lib/design-tokens'

/**
 * Highlights matching text within a display name.
 * Returns a React fragment with matched portions wrapped in <mark>.
 *
 * Usage in TraderRow/TraderCard:
 *   <HighlightedName text={displayName} query={searchQuery} />
 */
export function HighlightedName({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) {
    return <>{text}</>
  }

  const q = query.trim()
  const lowerText = text.toLowerCase()
  const lowerQuery = q.toLowerCase()
  const idx = lowerText.indexOf(lowerQuery)

  if (idx === -1) {
    return <>{text}</>
  }

  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + q.length)
  const after = text.slice(idx + q.length)

  return (
    <>
      {before}
      <mark
        style={{
          background: `${tokens.colors.accent.primary}30`,
          color: tokens.colors.accent.primary,
          borderRadius: '2px',
          padding: '0 1px',
          fontWeight: 700,
        }}
      >
        {match}
      </mark>
      {after}
    </>
  )
}
