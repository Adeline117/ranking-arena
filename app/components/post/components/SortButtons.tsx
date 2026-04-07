'use client'

import { tokens } from '@/lib/design-tokens'

const ARENA_PURPLE = tokens.colors.accent.brand

export type SortType = 'time' | 'likes' | 'personalized' | 'following'

interface SortButtonsProps {
  sortType: SortType
  setSortType: (type: SortType) => void
  t: (key: string) => string
  /** Whether the user is logged in (following tab requires auth) */
  isLoggedIn?: boolean
}

/**
 * Sort buttons for post feed
 * Allows switching between latest and hot sorting
 */
export function SortButtons({ sortType, setSortType, t, isLoggedIn }: SortButtonsProps): React.ReactNode {
  const getSortButtonStyle = (isActive: boolean) => ({
    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    border: `1px solid ${isActive ? ARENA_PURPLE : tokens.colors.border.primary}`,
    background: isActive ? 'var(--color-accent-primary-15)' : tokens.colors.bg.primary,
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: isActive ? 700 : 400,
    cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
      <button onClick={() => setSortType('time')} style={getSortButtonStyle(sortType === 'time')}>
        {t('latest')}
      </button>
      <button onClick={() => setSortType('likes')} style={getSortButtonStyle(sortType === 'likes')}>
        {t('hot')}
      </button>
      <button onClick={() => setSortType('personalized')} style={getSortButtonStyle(sortType === 'personalized')}>
        {t('recommended')}
      </button>
      {isLoggedIn && (
        <button onClick={() => setSortType('following')} style={getSortButtonStyle(sortType === 'following')}>
          {t('following')}
        </button>
      )}
    </div>
  )
}
