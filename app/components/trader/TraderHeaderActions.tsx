'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import TraderFollowButton from '../ui/TraderFollowButton'
import UserFollowButton from '../ui/UserFollowButton'
import WatchlistToggleButton from './WatchlistToggleButton'
import AlertBellButton from './AlertBellButton'
import TraderShareActions from './TraderShareActions'
import { ActionButton } from './TraderHeaderHelpers'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { trackEvent } from '@/lib/analytics/track'
import type { CompareAccountRef } from '@/lib/compare/identity'

interface TraderHeaderActionsProps {
  traderId: string
  handle: string
  source?: string
  displayName?: string
  effectiveAvatarUrl?: string
  isOwnProfile: boolean
  isRegistered?: boolean
  userId: string | null
  rank?: number | null
  roi90d?: number
  arenaScore?: number | null
  /** Called whenever the followers count changes (for the parent's animation) */
  onFollowChange?: (delta: 1 | -1) => void
}

/** Reactive Compare toggle button (P0-4) */
function CompareToggle({
  traderId,
  handle,
  source,
  avatarUrl,
}: {
  traderId: string
  handle: string
  source: string
  avatarUrl?: string
}) {
  const compareAccount: CompareAccountRef = { id: traderId, source }
  const isSelected = useComparisonStore((s) => s.isSelected(compareAccount))
  const addTrader = useComparisonStore((s) => s.addTrader)
  const removeTrader = useComparisonStore((s) => s.removeTrader)
  const canAddMore = useComparisonStore((s) => s.canAddMore())
  const { t } = useLanguage()

  const handleToggle = () => {
    if (isSelected) {
      removeTrader(compareAccount)
    } else {
      addTrader({ id: traderId, handle, source, avatarUrl })
    }
    trackEvent('compare_trader', { traderId, source, selected: !isSelected })
  }

  const label = isSelected ? t('comparing') : t('compare')
  const titleText = isSelected
    ? t('removeFromCompare')
    : !canAddMore
      ? t('compareListFull')
      : t('addToCompare')

  return (
    <ActionButton
      onClick={handleToggle}
      variant={isSelected ? 'accent' : 'ghost'}
      ariaLabel={label}
      icon={
        isSelected ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )
      }
    >
      <span title={titleText} style={{ opacity: !isSelected && !canAddMore ? 0.5 : 1 }}>
        {label}
      </span>
    </ActionButton>
  )
}

/**
 * Right-side action cluster for the trader header:
 * Edit (own profile) | Follow | Watchlist | Compare | Share rank card | Share dropdown
 *
 * Pulled out of TraderHeader.tsx 2026-04-09 to keep that file under
 * 500 lines and make the actions independently testable.
 */
export function TraderHeaderActions({
  traderId,
  handle,
  source,
  displayName,
  effectiveAvatarUrl,
  isOwnProfile,
  isRegistered,
  userId,
  rank,
  roi90d,
  arenaScore,
  onFollowChange,
}: TraderHeaderActionsProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const [moreOpen, setMoreOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])

  const resolvedDisplayName = displayName || formatDisplayName(handle, source)

  return (
    <Box
      ref={actionsRef}
      className="profile-header-actions action-buttons"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        position: 'relative',
        zIndex: 1,
      }}
    >
      {isOwnProfile && (
        <ActionButton
          onClick={() => router.push('/settings')}
          variant="accent"
          icon={
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          }
        >
          {t('editProfile')}
        </ActionButton>
      )}

      {/* Follow icon — rendered for anonymous users too: the buttons themselves
          open the login modal (TraderFollowButton also queues pendingFollow) */}
      {!isOwnProfile &&
        (isRegistered ? (
          <UserFollowButton targetUserId={traderId} currentUserId={userId} size="sm" />
        ) : (
          <TraderFollowButton
            traderId={traderId}
            source={source}
            userId={userId}
            onFollowChange={(isFollowing) => {
              onFollowChange?.(isFollowing ? 1 : -1)
            }}
          />
        ))}

      {/* Watchlist star */}
      {source && (
        <WatchlistToggleButton source={source} sourceTraderID={traderId} handle={handle} />
      )}

      <button
        type="button"
        className="trader-actions-more"
        aria-label={t('more')}
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        onClick={() => setMoreOpen((open) => !open)}
      >
        <span aria-hidden="true">•••</span>
        <span>{t('more')}</span>
      </button>

      <div
        className="trader-secondary-actions"
        data-open={moreOpen ? 'true' : 'false'}
        role={moreOpen ? 'menu' : undefined}
      >
        {/* Alert bell — notify me when this trader's rank/ROI/score moves (A4).
            Explicit opt-in; opens the existing AlertConfig in a modal. */}
        {!isOwnProfile && source && (
          <AlertBellButton traderId={traderId} traderHandle={handle || traderId} source={source} />
        )}

        {/* Compare toggle (P0-4) */}
        {!isOwnProfile && source && (
          <CompareToggle
            traderId={traderId}
            handle={handle}
            source={source}
            avatarUrl={effectiveAvatarUrl}
          />
        )}

        {/* Prominent quiz-grade share: OG rank-card preview + one-tap
            X / Telegram / WhatsApp / native-share + download card, with the
            sharer's referral code auto-appended when logged in. */}
        <TraderShareActions
          handle={handle}
          displayName={resolvedDisplayName}
          platform={source}
          rank={rank}
          roi={roi90d}
          arenaScore={arenaScore}
        />
      </div>
    </Box>
  )
}
