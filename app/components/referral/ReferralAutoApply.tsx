'use client'

/**
 * Unified, best-effort referral attribution for every authenticated entry path.
 * The pending code is durable; only an exact identity-bound success receipt or
 * a small allowlist of permanent failures may consume it.
 */

import { useEffect, useRef, useState } from 'react'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { peekPendingReferral, consumePendingReferralIfMatches } from '@/lib/referral/pending'
import {
  readReferralApplyAcknowledgement,
  readTerminalReferralApplyError,
} from '@/lib/referral/client-contract'
import { logger } from '@/lib/logger'
import type { ViewerKey } from '@/lib/auth/viewer-scope'

type ReferralViewerScope = {
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string | null
}

type ReferralOperation = {
  key: string
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string
  code: string
  controller: AbortController
}

const RETRY_BASE_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const RATE_LIMIT_RETRY_MIN_MS = 60_000

function operationIsCurrent(
  operation: ReferralOperation,
  activeOperation: ReferralOperation | null,
  currentScope: ReferralViewerScope
): boolean {
  return (
    activeOperation === operation &&
    !operation.controller.signal.aborted &&
    currentScope.viewerKey === operation.viewerKey &&
    currentScope.sessionGeneration === operation.sessionGeneration &&
    currentScope.userId === operation.userId &&
    peekPendingReferral() === operation.code
  )
}

export default function ReferralAutoApply() {
  const auth = useAuthSession()
  const [retryGeneration, setRetryGeneration] = useState(0)
  const currentScopeRef = useRef<ReferralViewerScope>({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  })
  currentScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  }
  const operationRef = useRef<ReferralOperation | null>(null)
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryStateRef = useRef<{ key: string; attempts: number } | null>(null)

  useEffect(() => {
    if (
      !auth.authChecked ||
      auth.loading ||
      !auth.accessToken ||
      !auth.userId ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      operationRef.current?.controller.abort()
      operationRef.current = null
      if (startTimerRef.current) clearTimeout(startTimerRef.current)
      startTimerRef.current = null
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      return
    }

    const code = peekPendingReferral()
    if (!code) {
      retryStateRef.current = null
      return
    }

    const key = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${code}`
    if (operationRef.current?.key === key) return

    operationRef.current?.controller.abort()
    if (startTimerRef.current) clearTimeout(startTimerRef.current)
    startTimerRef.current = null
    const operation: ReferralOperation = {
      key,
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      code,
      controller: new AbortController(),
    }
    // Physical lock is installed before the first await so duplicate effects in
    // the same frame cannot submit the same viewer/code operation twice.
    operationRef.current = operation
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null

    const scheduleRetry = (status: number) => {
      if (!operationIsCurrent(operation, operationRef.current, currentScopeRef.current)) return
      const previous = retryStateRef.current
      const attempts = previous?.key === key ? previous.attempts + 1 : 1
      retryStateRef.current = { key, attempts }
      const exponentialDelay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, Math.min(attempts - 1, 6)),
        RETRY_MAX_DELAY_MS
      )
      const delay =
        status === 429 ? Math.max(RATE_LIMIT_RETRY_MIN_MS, exponentialDelay) : exponentialDelay
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        if (
          currentScopeRef.current.viewerKey === operation.viewerKey &&
          currentScopeRef.current.sessionGeneration === operation.sessionGeneration &&
          currentScopeRef.current.userId === operation.userId &&
          peekPendingReferral() === operation.code
        ) {
          setRetryGeneration((generation) => generation + 1)
        }
      }, delay)
    }

    // Starting on the next task lets a same-frame mount/cleanup/remount (for
    // example React Strict Mode) cancel the superseded attempt before fetch can
    // put a duplicate write on the wire.
    startTimerRef.current = setTimeout(() => {
      startTimerRef.current = null
      if (!operationIsCurrent(operation, operationRef.current, currentScopeRef.current)) return

      void (async () => {
        try {
          const result = await authedFetch<unknown>(
            '/api/referral/apply',
            'POST',
            auth.accessToken,
            { code: operation.code },
            15_000,
            {
              expectedUserId: operation.userId,
              expectedSessionGeneration: operation.sessionGeneration,
              signal: operation.controller.signal,
            }
          )
          if (
            result.stale ||
            !operationIsCurrent(operation, operationRef.current, currentScopeRef.current)
          ) {
            return
          }

          const acknowledgement =
            result.status === 200 && result.ok
              ? readReferralApplyAcknowledgement(result.data, {
                  viewerId: operation.userId,
                  code: operation.code,
                })
              : null
          const terminalError =
            !result.ok && result.status !== 0
              ? readTerminalReferralApplyError(result.data, result.status)
              : null

          if (acknowledgement || terminalError) {
            if (consumePendingReferralIfMatches(operation.code)) {
              retryStateRef.current = null
              logger.info(
                acknowledgement
                  ? `[referral] attribution ${acknowledgement.status}`
                  : `[referral] terminal apply result ${terminalError}`
              )
            } else {
              // If storage rejected deletion but the same code is still current,
              // retain it and retry. A different current code is deliberately
              // left for a newer operation.
              scheduleRetry(0)
            }
            return
          }

          // Network/timeout, throttling, server faults, and any malformed or
          // expanded response retain the exact pending code and retry later.
          logger.warn(`[referral] untrusted apply response (status ${result.status}) — retained`)
          scheduleRetry(result.status)
        } catch (error) {
          if (!operationIsCurrent(operation, operationRef.current, currentScopeRef.current)) return
          logger.error('[referral] apply failed (non-fatal):', error)
          scheduleRetry(0)
        } finally {
          if (operationRef.current === operation) operationRef.current = null
        }
      })()
    }, 0)

    return () => {
      if (operationRef.current === operation) {
        operation.controller.abort()
        operationRef.current = null
      }
      if (startTimerRef.current) {
        clearTimeout(startTimerRef.current)
        startTimerRef.current = null
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [
    auth.accessToken,
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    retryGeneration,
  ])

  return null
}
