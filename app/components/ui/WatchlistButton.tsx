'use client'

import { useWatchlist } from '@/lib/hooks/useWatchlist'
import { tokens } from '@/lib/design-tokens'

interface WatchlistButtonProps {
  source: string
  sourceTraderID: string
  handle?: string
  size?: number
}

export default function WatchlistButton({ source, sourceTraderID, handle, size = 16 }: WatchlistButtonProps) {
  const { isWatched, addToWatchlist, removeFromWatchlist } = useWatchlist()
  const watched = isWatched(source, sourceTraderID)

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (watched) {
      await removeFromWatchlist(source, sourceTraderID)
    } else {
      await addToWatchlist(source, sourceTraderID, handle)
    }
  }

  return (
    <button
      onClick={toggle}
      title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 4,
        borderRadius: tokens.radius.sm,
        color: watched ? tokens.colors.accent.warning : 'var(--color-text-tertiary)',
        transition: `color ${tokens.transition.base}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill={watched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  )
}
