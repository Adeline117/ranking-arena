'use client'

import { useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useWatchlist } from '@/lib/hooks/useWatchlist'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface WatchlistToggleButtonProps {
  source: string
  sourceTraderID: string
  handle?: string
}

export default function WatchlistToggleButton({
  source,
  sourceTraderID,
  handle,
}: WatchlistToggleButtonProps) {
  const { isLoggedIn } = useAuthSession()
  const { isWatched, addToWatchlist, removeFromWatchlist } = useWatchlist()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const pendingRef = useRef(false)
  const [isLoading, setIsLoading] = useState(false)

  const watched = isWatched(source, sourceTraderID)

  const handleClick = async () => {
    if (pendingRef.current) return
    if (!isLoggedIn) {
      useLoginModal.getState().openLoginModal()
      return
    }

    pendingRef.current = true
    setIsLoading(true)
    try {
      if (watched) {
        await removeFromWatchlist(source, sourceTraderID)
        showToast(t('removedFromWatchlist'), 'info')
      } else {
        await addToWatchlist(source, sourceTraderID, handle)
        showToast(t('addedToWatchlist'), 'success')
      }
    } catch {
      showToast(t('watchlistError'), 'error')
    } finally {
      pendingRef.current = false
      setIsLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      aria-label={watched ? t('removeFromWatchlist') : t('addToWatchlist')}
      aria-pressed={watched}
      title={watched ? t('removeFromWatchlist') : t('addToWatchlist')}
      className="interactive-scale"
      style={{
        padding: '8px 12px',
        minHeight: 44,
        borderRadius: tokens.radius.lg,
        border: watched
          ? `1px solid var(--color-accent-warning, #f59e0b)`
          : `1px solid ${tokens.colors.border.primary}`,
        background: watched
          ? 'var(--color-accent-warning-10, rgba(245, 158, 11, 0.1))'
          : tokens.glass.bg.light,
        color: watched ? 'var(--color-accent-warning, #f59e0b)' : tokens.colors.text.secondary,
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.6 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (!watched) e.currentTarget.style.borderColor = 'var(--color-accent-warning, #f59e0b)'
      }}
      onMouseLeave={(e) => {
        if (!watched) e.currentTarget.style.borderColor = tokens.colors.border.primary
      }}
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill={watched ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  )
}
