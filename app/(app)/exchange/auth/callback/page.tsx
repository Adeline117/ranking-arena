'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { authedFetch } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  captureExchangeViewer,
  isExchangeViewerCurrent,
  type ExchangeViewerSnapshot,
} from '@/lib/exchange/viewer-scope'
import { resolveOAuthCallbackExchange } from '../oauth-client'

type CallbackStatus = 'loading' | 'success' | 'error'

type CallbackResponse = {
  success?: unknown
  error?: unknown
  data?: {
    viewerId?: unknown
    exchange?: unknown
  }
}

type CallbackOperation = {
  id: number
  viewer: ExchangeViewerSnapshot
  exchange: string
  controller: AbortController
  redirectTimer: ReturnType<typeof setTimeout> | null
}

type ExchangeAuthCallbackContentProps = {
  auth: AuthSessionReturn
  redirectDelayMs?: number
}

export function ExchangeAuthCallbackContent({
  auth,
  redirectDelayMs = 3000,
}: ExchangeAuthCallbackContentProps) {
  const searchParams = useSearchParams()
  const searchKey = searchParams.toString()
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const { t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const authRef = useRef(auth)
  authRef.current = auth
  const mountedRef = useRef(false)
  const operationRef = useRef<CallbackOperation | null>(null)
  const nextOperationIdRef = useRef(0)
  const [status, setStatus] = useState<CallbackStatus>('loading')
  const [message, setMessage] = useState('')
  const hasAccessToken = Boolean(auth.accessToken)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const operation = operationRef.current
      operation?.controller.abort()
      if (operation?.redirectTimer) clearTimeout(operation.redirectTimer)
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(searchKey)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')

    if (error) {
      setStatus('error')
      setMessage(tRef.current('authFailedPrefix').replace('{error}', error))
      return
    }

    if (!code || !state) {
      setStatus('error')
      setMessage(tRef.current('missingAuthParams'))
      return
    }

    const exchange = resolveOAuthCallbackExchange(params.get('exchange'), state)
    if (!exchange) {
      setStatus('error')
      setMessage(tRef.current('missingAuthParams'))
      return
    }

    if (!auth.authChecked || auth.loading) return
    if (!auth.userId) {
      setStatus('error')
      setMessage(tRef.current('pleaseLogin'))
      routerRef.current.push(`/login?redirect=${encodeURIComponent('/exchange/auth')}`)
      return
    }

    const viewer = captureExchangeViewer(authRef.current, authRef.current.userId)
    if (!viewer) {
      setStatus('error')
      setMessage(tRef.current('authorizationFailed'))
      return
    }

    const previousOperation = operationRef.current
    previousOperation?.controller.abort()
    if (previousOperation?.redirectTimer) clearTimeout(previousOperation.redirectTimer)

    const operation: CallbackOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      exchange,
      controller: new AbortController(),
      redirectTimer: null,
    }
    operationRef.current = operation
    setStatus('loading')
    setMessage('')

    const operationIsCurrent = () =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      operationRef.current.exchange === exchange &&
      isExchangeViewerCurrent(viewer, authRef.current, authRef.current.userId)

    const handleCallback = async () => {
      try {
        const result = await authedFetch<CallbackResponse>(
          '/api/exchange/oauth/callback',
          'POST',
          viewer.accessToken,
          { exchange, code, state },
          20_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (!operationIsCurrent() || result.stale) return

        const acknowledgement = result.data?.data
        if (
          !result.ok ||
          result.data?.success !== true ||
          acknowledgement?.viewerId !== viewer.userId ||
          acknowledgement.exchange !== exchange
        ) {
          const errorMessage =
            typeof result.data?.error === 'string'
              ? result.data.error
              : tRef.current('authorizationFailed')
          throw new Error(errorMessage)
        }

        if (!operationIsCurrent()) return
        setStatus('success')
        setMessage(tRef.current('authorizationSuccessRedirecting'))
        operation.redirectTimer = setTimeout(() => {
          if (!operationIsCurrent()) return
          operationRef.current = null
          routerRef.current.push('/settings')
        }, redirectDelayMs)
      } catch (callbackError) {
        if (!operationIsCurrent()) return
        setStatus('error')
        setMessage(
          callbackError instanceof Error
            ? callbackError.message
            : tRef.current('authorizationFailed')
        )
        operationRef.current = null
      }
    }

    void handleCallback()
    return () => {
      operation.controller.abort()
      if (operation.redirectTimer) clearTimeout(operation.redirectTimer)
      if (operationRef.current?.id === operation.id) operationRef.current = null
    }
  }, [
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    hasAccessToken,
    redirectDelayMs,
    searchKey,
  ])

  const handleRetry = () => {
    const viewer = captureExchangeViewer(authRef.current, authRef.current.userId)
    if (!viewer || !isExchangeViewerCurrent(viewer, authRef.current, authRef.current.userId)) return
    router.push('/exchange/auth')
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: tokens.spacing[10],
          textAlign: 'center',
        }}
      >
        {status === 'loading' && (
          <>
            <Text size="lg" style={{ marginBottom: tokens.spacing[4] }}>
              {t('processingAuthorization')}
            </Text>
            <Text size="sm" color="secondary">
              {t('pleaseWaitShort')}
            </Text>
          </>
        )}

        {status === 'success' && (
          <>
            <Text
              size="lg"
              weight="bold"
              style={{ marginBottom: tokens.spacing[4], color: tokens.colors.accent.success }}
            >
              {t('authorizationSuccess')}
            </Text>
            <Text size="sm" color="secondary">
              {message}
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <Text
              size="lg"
              weight="bold"
              style={{ marginBottom: tokens.spacing[4], color: tokens.colors.accent.error }}
            >
              {t('authorizationFailed')}
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {message}
            </Text>
            <button
              onClick={handleRetry}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.primary,
                cursor: 'pointer',
              }}
            >
              {t('retry')}
            </button>
          </>
        )}
      </Box>
    </Box>
  )
}

export default function ExchangeAuthCallbackPage() {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  return (
    <Suspense
      fallback={
        <Box
          style={{
            minHeight: '100vh',
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
          }}
        >
          <Box
            style={{
              maxWidth: 600,
              margin: '0 auto',
              padding: tokens.spacing[10],
              textAlign: 'center',
            }}
          >
            <Text size="lg">{t('loading')}</Text>
          </Box>
        </Box>
      }
    >
      <ExchangeAuthCallbackContent key={scopeKey} auth={auth} />
    </Suspense>
  )
}
