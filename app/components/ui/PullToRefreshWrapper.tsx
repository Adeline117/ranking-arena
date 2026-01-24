'use client'

import { ReactNode } from 'react'
import { usePullToRefresh, PullToRefreshState } from '@/lib/hooks/useMobileGestures'
import { tokens } from '@/lib/design-tokens'

interface PullToRefreshWrapperProps {
  onRefresh: () => Promise<void>
  children: ReactNode
  disabled?: boolean
}

function PullIndicator({ state, pullDistance }: { state: PullToRefreshState; pullDistance: number }) {
  if (state === 'idle') return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: pullDistance,
        overflow: 'hidden',
        transition: state === 'refreshing' ? 'height 0.2s ease' : 'none',
      }}
    >
      {state === 'refreshing' ? (
        <div
          style={{
            width: 20,
            height: 20,
            border: `2px solid ${tokens.colors.border.primary}`,
            borderTopColor: tokens.colors.accent.primary,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
      ) : state === 'ready' ? (
        <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary }}>
          Release to refresh
        </span>
      ) : (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.text.tertiary}
          strokeWidth="2"
          style={{
            transform: `rotate(${Math.min(pullDistance * 3, 180)}deg)`,
            transition: 'transform 0.1s',
          }}
        >
          <path d="M12 5v14M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  )
}

export default function PullToRefreshWrapper({ onRefresh, children, disabled = false }: PullToRefreshWrapperProps) {
  const { containerRef, state, pullDistance } = usePullToRefresh({
    onRefresh,
    disabled,
  })

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <PullIndicator state={state} pullDistance={pullDistance} />
      {children}
    </div>
  )
}
