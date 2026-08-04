'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import {
  isValidTipSessionId,
  readTipVerificationFailure,
  readVerifiedTipPayment,
  type VerifiedTipPayment,
} from '@/lib/stripe/tip-client-contract'
import { tipPostHref } from './tip-success-links'

const AUTO_REDIRECT_SECONDS = 15
const PENDING_RETRY_DELAYS_MS = [0, 800, 1_200, 1_800] as const

type VerificationStatus = 'verifying' | 'success' | 'error'

type VerificationOperation = {
  controller: AbortController
  id: number
  scopeKey: string
  sessionId: string
  viewer: SettingsViewerSnapshot
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve()
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function TipSuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth

  const sessionId = searchParams.get('session_id')
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${sessionId ?? ''}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const mountedRef = useRef(false)
  const operationRef = useRef<VerificationOperation | null>(null)
  const nextOperationIdRef = useRef(0)
  const stateOwnerScopeRef = useRef(scopeKey)
  const [statusState, setStatus] = useState<VerificationStatus>('verifying')
  const [paymentState, setPayment] = useState<VerifiedTipPayment | null>(null)
  const [countdownState, setCountdown] = useState(AUTO_REDIRECT_SECONDS)
  const [dismissedState, setDismissed] = useState(false)
  const [runningState, setRunning] = useState(false)

  const stateOwned = stateOwnerScopeRef.current === scopeKey
  const status: VerificationStatus = stateOwned ? statusState : 'verifying'
  const payment = stateOwned ? paymentState : null
  const countdown = stateOwned ? countdownState : AUTO_REDIRECT_SECONDS
  const dismissed = stateOwned ? dismissedState : false
  const running = stateOwned ? runningState : false

  const operationIsCurrent = useCallback((operation: VerificationOperation): boolean => {
    return (
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      scopeKeyRef.current === operation.scopeKey &&
      sessionIdRef.current === operation.sessionId &&
      isSettingsViewerCurrent(operation.viewer, authRef.current)
    )
  }, [])

  const verifyPayment = useCallback(async () => {
    if (operationRef.current) return
    const currentSessionId = sessionIdRef.current
    const viewer = captureSettingsViewer(authRef.current)
    const currentScopeKey = scopeKeyRef.current
    if (!isValidTipSessionId(currentSessionId) || !viewer) {
      if (authRef.current.authChecked && !authRef.current.loading) setStatus('error')
      return
    }

    const operation: VerificationOperation = {
      controller: new AbortController(),
      id: ++nextOperationIdRef.current,
      scopeKey: currentScopeKey,
      sessionId: currentSessionId,
      viewer,
    }
    operationRef.current = operation
    setStatus('verifying')
    setPayment(null)
    setRunning(true)

    try {
      for (const delay of PENDING_RETRY_DELAYS_MS) {
        await waitForRetry(delay, operation.controller.signal)
        if (!operationIsCurrent(operation)) return

        const result = await authedFetch<unknown>(
          '/api/tip/verify-session',
          'POST',
          operation.viewer.accessToken,
          { session_id: operation.sessionId },
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (!operationIsCurrent(operation) || result.stale) return

        if (result.ok && result.status === 200) {
          const verified = readVerifiedTipPayment(result.data, {
            viewerId: operation.viewer.userId,
            sessionId: operation.sessionId,
          })
          if (!verified) {
            setStatus('error')
            return
          }
          setPayment(verified)
          setCountdown(AUTO_REDIRECT_SECONDS)
          setDismissed(false)
          setStatus('success')
          return
        }

        const failure = readTipVerificationFailure(result.data, result.status)
        if (failure === 'pending' && delay !== PENDING_RETRY_DELAYS_MS.at(-1)) continue
        setStatus('error')
        return
      }
      setStatus('error')
    } catch (error) {
      if (operationIsCurrent(operation)) {
        logger.error('[Tip Success] Verification failed', error)
        setStatus('error')
      }
    } finally {
      if (operationRef.current?.id === operation.id) {
        operationRef.current = null
        if (scopeKeyRef.current === operation.scopeKey) setRunning(false)
      }
    }
  }, [operationIsCurrent])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    operationRef.current?.controller.abort()
    operationRef.current = null
    stateOwnerScopeRef.current = scopeKey
    setStatus('verifying')
    setPayment(null)
    setCountdown(AUTO_REDIRECT_SECONDS)
    setDismissed(false)
    setRunning(false)

    const currentAuth = authRef.current
    if (!currentAuth.authChecked || currentAuth.loading) return
    if (!isValidTipSessionId(sessionId) || !captureSettingsViewer(currentAuth)) {
      setStatus('error')
      return
    }
    void verifyPayment()
  }, [auth.accessToken, auth.authChecked, auth.loading, scopeKey, sessionId, verifyPayment])

  useEffect(() => {
    if (status !== 'success' || dismissed || !payment) return
    if (countdown <= 0) {
      router.push('/')
      return
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1_000)
    return () => window.clearTimeout(timer)
  }, [countdown, dismissed, payment, router, status])

  const handleRetry = useCallback(() => {
    if (operationRef.current) return
    void verifyPayment()
  }, [verifyPayment])

  const postHref = tipPostHref(payment?.postId)
  const formattedAmount = payment ? `$${(payment.amountCents / 100).toFixed(2)}` : null

  const handleShare = useCallback(async () => {
    if (status !== 'success' || !payment) return
    const href = tipPostHref(payment.postId)
    const url = typeof window !== 'undefined' && href ? `${window.location.origin}${href}` : ''
    const text = t('tipShareTextGeneric')
    trackEvent('tip_share', { has_handle: 0 })
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: t('tipSuccess'), text, url })
        return
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url ? `${text} ${url}` : text)
      }
    } catch {
      // The user can cancel a share sheet or deny clipboard access.
    }
  }, [payment, status, t])

  if (status === 'verifying') {
    return (
      <main
        className="flex min-h-screen items-center justify-center px-4"
        style={{ background: 'var(--color-bg-primary)' }}
      >
        <div className="max-w-md text-center" role="status" aria-live="polite">
          <div
            className="mx-auto mb-6 h-12 w-12 animate-spin rounded-full border-4 border-current border-t-transparent"
            style={{ color: 'var(--color-accent-primary)' }}
            aria-hidden="true"
          />
          <h1 className="mb-2 text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('verifying')}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{t('processing')}</p>
        </div>
      </main>
    )
  }

  if (status === 'error' || !payment || !formattedAmount) {
    return (
      <main
        className="flex min-h-screen items-center justify-center px-4"
        style={{ background: 'var(--color-bg-primary)' }}
      >
        <div className="w-full max-w-md text-center" role="alert">
          <h1 className="mb-2 text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('verificationFailed')}
          </h1>
          <p className="mb-6" style={{ color: 'var(--color-text-secondary)' }}>
            {t('tipNoRecordDesc')}
          </p>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              className="min-h-11 w-full rounded-lg px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50"
              style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
              onClick={handleRetry}
              disabled={running || !isValidTipSessionId(sessionId)}
            >
              {running ? t('verifying') : t('retry')}
            </button>
            <Link
              href="/"
              className="flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium transition-colors"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {t('backToHome')}
            </Link>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4"
      style={{ background: 'var(--color-bg-primary)' }}
    >
      <div className="w-full max-w-md text-center" aria-live="polite">
        <div className="mb-6 flex justify-center" aria-hidden="true">
          <div
            className="flex h-20 w-20 items-center justify-center rounded-full"
            style={{ background: 'var(--color-accent-success-20)' }}
          >
            <svg
              className="h-10 w-10"
              style={{ color: 'var(--color-accent-success)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>

        <h1 className="mb-2 text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          {t('tipSuccess')}
        </h1>
        <p className="mb-2 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          {t('tipSentAmount').replace('{amount}', formattedAmount)}
        </p>
        <p className="mb-6" style={{ color: 'var(--color-text-secondary)' }}>
          {t('tipSuccessMessage')}
        </p>

        <div className="flex flex-col gap-3">
          <Link
            href={postHref ?? '/groups'}
            className="flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
          >
            {postHref ? t('backToPost') : t('backToFeed')}
          </Link>
          <button
            type="button"
            onClick={handleShare}
            className="min-h-11 w-full rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-primary)',
              color: 'var(--color-text-primary)',
            }}
          >
            {t('tipShareCta')}
          </button>
          <Link
            href="/"
            className="flex min-h-11 w-full items-center justify-center px-4 py-3 text-sm font-medium transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {t('backToHome')}
          </Link>

          {!dismissed ? (
            <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
              {t('redirectingCountdown').replace('{seconds}', String(countdown))}{' '}
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="inline-flex min-h-11 items-center px-2"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-accent-primary)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {t('stayOnPage')}
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </main>
  )
}

export default function TipSuccessPage() {
  return (
    <Suspense
      fallback={
        <main
          className="flex min-h-screen items-center justify-center"
          style={{ background: 'var(--color-bg-primary)' }}
        >
          <div
            className="text-center"
            role="status"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Loading...
          </div>
        </main>
      }
    >
      <TipSuccessContent />
    </Suspense>
  )
}
