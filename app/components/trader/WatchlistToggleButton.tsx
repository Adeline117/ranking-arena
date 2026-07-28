'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { isWatchlistViewerChangedError, useWatchlist } from '@/lib/hooks/useWatchlist'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { trackEvent } from '@/lib/analytics/track'
import {
  consumeProfileActionLogin,
  profileTraderTarget,
  queueProfileActionLogin,
  type ProfileActionIntent,
} from '@/lib/auth/profile-action-login'

interface WatchlistToggleButtonProps {
  source: string
  sourceTraderID: string
  handle?: string
  loginReturnPath?: string
}

export default function WatchlistToggleButton({
  source,
  sourceTraderID,
  handle,
  loginReturnPath,
}: WatchlistToggleButtonProps) {
  const router = useRouter()
  const { isLoggedIn, userId, viewerKey, sessionGeneration, loading, authChecked } =
    useAuthSession()
  const {
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    isLoading: watchlistLoading,
    error: watchlistLoadError,
    refetch: refetchWatchlist,
  } = useWatchlist()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const nextOperationIdRef = useRef(0)
  const operationRef = useRef<{ id: number; scopeKey: string } | null>(null)
  const scopeKey = `${viewerKey}\u0000${sessionGeneration}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const [loadingScope, setLoadingScope] = useState<string | null>(null)
  const isLoading = loadingScope === scopeKey
  const authResolving = Boolean(loading || authChecked === false)

  const watched = isWatched(source, sourceTraderID)

  const redirectToLogin = useCallback(
    (action: ProfileActionIntent) => {
      router.push(
        queueProfileActionLogin({
          action,
          target: profileTraderTarget(source, sourceTraderID),
          fallbackPath: loginReturnPath,
          initiatingUserId: userId,
        })
      )
    },
    [loginReturnPath, router, source, sourceTraderID, userId]
  )

  const executeWatchlistAction = useCallback(
    async (action: 'watch' | 'unwatch') => {
      if (operationRef.current?.scopeKey === scopeKey) return
      const operation = { id: ++nextOperationIdRef.current, scopeKey }
      operationRef.current = operation
      setLoadingScope(scopeKey)
      const operationIsCurrent = () =>
        operationRef.current?.id === operation.id && scopeKeyRef.current === operation.scopeKey
      try {
        if (action === 'unwatch') {
          await removeFromWatchlist(source, sourceTraderID)
          if (!operationIsCurrent()) return
          showToast(t('removedFromWatchlist'), 'info')
        } else {
          await addToWatchlist(source, sourceTraderID, handle)
          if (!operationIsCurrent()) return
          trackEvent('save_trader', { traderId: sourceTraderID, source })
          showToast(t('addedToWatchlist'), 'success')
        }
      } catch (error) {
        if (!operationIsCurrent() || isWatchlistViewerChangedError(error)) return
        if (error instanceof Error && /(?:^|\s)401$/.test(error.message)) {
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin(action === 'watch' ? 'watch-trader' : 'unwatch-trader')
        } else {
          showToast(t('watchlistError'), 'error')
        }
      } finally {
        if (operationRef.current?.id === operation.id) {
          operationRef.current = null
          if (scopeKeyRef.current === operation.scopeKey) setLoadingScope(null)
        }
      }
    },
    [
      addToWatchlist,
      handle,
      redirectToLogin,
      removeFromWatchlist,
      showToast,
      source,
      sourceTraderID,
      scopeKey,
      t,
    ]
  )

  const handleClick = () => {
    if (operationRef.current?.scopeKey === scopeKey || authResolving || watchlistLoading) return
    if (!isLoggedIn) {
      redirectToLogin('watch-trader')
      return
    }
    if (watchlistLoadError) {
      showToast(t('watchlistError'), 'error')
      void refetchWatchlist()
      return
    }

    void executeWatchlistAction(watched ? 'unwatch' : 'watch')
  }

  useEffect(() => {
    if (!isLoggedIn || !userId || authResolving) return
    const action = consumeProfileActionLogin({
      actions: ['watch-trader', 'unwatch-trader'],
      target: profileTraderTarget(source, sourceTraderID),
      currentUserId: userId,
    })
    if (action) {
      void executeWatchlistAction(action === 'watch-trader' ? 'watch' : 'unwatch')
    }
  }, [authResolving, executeWatchlistAction, isLoggedIn, source, sourceTraderID, userId])

  const buttonBusy = isLoading || watchlistLoading
  const buttonDisabled = buttonBusy || authResolving

  return (
    <button
      onClick={handleClick}
      aria-label={watched ? t('removeFromWatchlist') : t('addToWatchlist')}
      aria-pressed={watched}
      aria-busy={buttonBusy}
      disabled={buttonDisabled}
      title={watched ? t('removeFromWatchlist') : t('addToWatchlist')}
      className="interactive-scale"
      style={{
        padding: '8px 12px',
        minHeight: 44,
        borderRadius: tokens.radius.lg,
        border: watched
          ? `1px solid ${tokens.colors.accent.warning}`
          : `1px solid ${tokens.colors.border.primary}`,
        background: watched
          ? 'var(--color-accent-warning-10, rgba(245, 158, 11, 0.1))'
          : tokens.glass.bg.light,
        color: watched ? tokens.colors.accent.warning : tokens.colors.text.secondary,
        cursor: buttonDisabled ? 'not-allowed' : 'pointer',
        opacity: buttonDisabled ? 0.6 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.semibold,
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (!watched) e.currentTarget.style.borderColor = tokens.colors.accent.warning
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
