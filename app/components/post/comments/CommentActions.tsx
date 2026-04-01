'use client'

import { tokens } from '@/lib/design-tokens'
import { ARENA_PURPLE } from '@/lib/utils/content'
import type { CommentSortMode } from './comment-types'

function SkeletonBlock({ width, height }: { width: string; height: number }): React.ReactNode {
  return (
    <div style={{
      width,
      height,
      borderRadius: tokens.radius.sm,
      background: tokens.colors.bg.tertiary,
      animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  )
}

export function CommentSkeleton(): React.ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: tokens.colors.bg.tertiary,
            animation: 'pulse 1.5s ease-in-out infinite',
            flexShrink: 0,
          }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SkeletonBlock width={`${40 + i * 10}%`} height={12} />
            <SkeletonBlock width={`${60 + i * 5}%`} height={14} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmptyComments({ t }: { t: (key: string) => string }): React.ReactNode {
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px', color: tokens.colors.text.tertiary }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 8px' }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{t('noCommentsYet')}</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{t('beFirstToComment')}</div>
    </div>
  )
}

interface CommentSortToggleProps {
  commentSort: CommentSortMode
  onSortChange: (sort: CommentSortMode) => void
  t: (key: string) => string
}

export function CommentSortToggle({ commentSort, onSortChange, t }: CommentSortToggleProps): React.ReactNode {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
      {(['best', 'time'] as const).map(mode => (
        <button
          key={mode}
          onClick={() => onSortChange(mode)}
          style={{
            padding: '4px 12px',
            borderRadius: tokens.radius.md,
            border: 'none',
            background: commentSort === mode ? `${ARENA_PURPLE}20` : 'transparent',
            color: commentSort === mode ? ARENA_PURPLE : tokens.colors.text.tertiary,
            fontSize: 12,
            fontWeight: commentSort === mode ? 700 : 500,
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {mode === 'best' ? t('sortBest') : t('sortNewest')}
        </button>
      ))}
    </div>
  )
}
