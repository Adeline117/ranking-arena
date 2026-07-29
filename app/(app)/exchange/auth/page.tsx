'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { t as staticT } from '@/lib/i18n'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  captureExchangeViewer,
  isExchangeViewerCurrent,
  type ExchangeViewerSnapshot,
} from '@/lib/exchange/viewer-scope'
import { EXCHANGE_BIND_LIST } from './api-key/exchange-configs'
import { requestExchangeOAuthUrl } from './oauth-client'

// Single source of truth: display names + OAuth capability live in exchange-configs.
const EXCHANGES = EXCHANGE_BIND_LIST

type ExchangeAuthContentProps = {
  auth: AuthSessionReturn
  redirectToOAuth?: (url: string) => void
}

type OAuthOperation = {
  id: number
  viewer: ExchangeViewerSnapshot
  exchange: string
  controller: AbortController
}

type OAuthUiOwner = Pick<ExchangeViewerSnapshot, 'viewerKey' | 'sessionGeneration' | 'userId'>

function sameOAuthViewer(
  owner: OAuthUiOwner | null,
  viewer: ExchangeViewerSnapshot | null
): boolean {
  return (
    owner !== null &&
    viewer !== null &&
    owner.viewerKey === viewer.viewerKey &&
    owner.sessionGeneration === viewer.sessionGeneration &&
    owner.userId === viewer.userId
  )
}

function defaultOAuthRedirect(url: string): void {
  window.location.href = url
}

export function ExchangeAuthContent({
  auth,
  redirectToOAuth = defaultOAuthRedirect,
}: ExchangeAuthContentProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const exchangeParam = searchParams.get('exchange')
  const authRef = useRef(auth)
  authRef.current = auth
  const mountedRef = useRef(false)
  const operationRef = useRef<OAuthOperation | null>(null)
  const nextOperationIdRef = useRef(0)
  const [loadingState, setLoading] = useState(false)
  const [uiOwner, setUiOwner] = useState<OAuthUiOwner | null>(null)
  const [errorState, setError] = useState<string | null>(null)
  const renderedViewer = captureExchangeViewer(auth, auth.userId)
  const ownsUi = sameOAuthViewer(uiOwner, renderedViewer)
  const loading = ownsUi ? loadingState : false
  const error = ownsUi ? errorState : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = operationRef.current
    if (
      operation &&
      !isExchangeViewerCurrent(operation.viewer, authRef.current, authRef.current.userId)
    ) {
      operation.controller.abort()
      operationRef.current = null
    }

    if (auth.authChecked && !auth.loading && !auth.userId) {
      router.replace(`/login?redirect=${encodeURIComponent('/exchange/auth')}`)
    }
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, auth.viewerKey, router])

  const handleOAuth = async (exchange: string) => {
    const viewer = captureExchangeViewer(authRef.current, authRef.current.userId)
    if (!viewer) {
      showToast(t('pleaseLogin'), 'warning')
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        router.push(`/login?redirect=${encodeURIComponent('/exchange/auth')}`)
      }
      return
    }

    const activeOperation = operationRef.current
    if (
      activeOperation &&
      isExchangeViewerCurrent(activeOperation.viewer, authRef.current, authRef.current.userId)
    ) {
      return
    }
    activeOperation?.controller.abort()

    const operation: OAuthOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      exchange,
      controller: new AbortController(),
    }
    operationRef.current = operation
    setUiOwner(viewer)
    setLoading(true)
    setError(null)
    const operationIsCurrent = () =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      operationRef.current.exchange === exchange &&
      isExchangeViewerCurrent(viewer, authRef.current, authRef.current.userId)

    try {
      const authUrl = await requestExchangeOAuthUrl(
        exchange,
        {
          accessToken: viewer.accessToken,
          sessionGeneration: viewer.sessionGeneration,
          userId: viewer.userId,
        },
        operation.controller.signal
      )
      // Last CAS immediately before the irreversible cross-origin navigation.
      if (!operationIsCurrent()) return
      redirectToOAuth(authUrl)
    } catch (_err: unknown) {
      if (operationIsCurrent()) setError(t('authorizationFailed'))
    } finally {
      if (operationIsCurrent()) {
        setLoading(false)
        operationRef.current = null
      }
    }
  }

  const navigateWithinViewer = (path: string) => {
    const viewer = captureExchangeViewer(authRef.current, authRef.current.userId)
    if (!viewer || !isExchangeViewerCurrent(viewer, authRef.current, authRef.current.userId)) return
    operationRef.current?.controller.abort()
    operationRef.current = null
    router.push(path)
  }

  const handleApiKey = (exchange: string) => {
    navigateWithinViewer(`/exchange/auth/api-key?exchange=${exchange}`)
  }

  if (!renderedViewer) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  const selectedExchange = EXCHANGES.find((e) => e.id === exchangeParam)

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          {t('bindExchangeAccount')}
        </Text>

        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              background: `${alpha(tokens.colors.accent.error, 13)}`,
              border: `1px solid ${tokens.colors.accent.error}`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>
              {error}
            </Text>
          </Box>
        )}

        {selectedExchange ? (
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{ marginBottom: tokens.spacing[4] }}
          >
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[4],
              }}
            >
              <ExchangeLogo exchange={selectedExchange.id} size={32} />
              <Text size="lg" weight="bold">
                {selectedExchange.name}
              </Text>
            </Box>

            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('selectAuthMethod')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {selectedExchange.oauthSupported ? (
                <Button
                  variant="primary"
                  onClick={() => handleOAuth(selectedExchange.id)}
                  disabled={loading}
                  fullWidth
                >
                  {loading
                    ? t('authorizing')
                    : t('useOAuthAuthorize').replace('{exchange}', selectedExchange.name)}
                </Button>
              ) : (
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('oauthNotSupported').replace('{exchange}', selectedExchange.name)}
                </Text>
              )}

              <Button
                variant="secondary"
                onClick={() => handleApiKey(selectedExchange.id)}
                fullWidth
              >
                {t('useApiKeyAuthorize')}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{ marginBottom: tokens.spacing[4] }}
          >
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('selectExchangeToBind')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {EXCHANGES.map((exchange) => (
                <Button
                  key={exchange.id}
                  variant="secondary"
                  onClick={() => navigateWithinViewer(`/exchange/auth?exchange=${exchange.id}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}
                >
                  <ExchangeLogo exchange={exchange.id} size={20} />
                  {exchange.name}
                </Button>
              ))}
            </Box>
          </Box>
        )}

        {/* Security Assurance */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[4] }}
        >
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[4],
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke={tokens.colors.accent.brand}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <Text size="lg" weight="bold">
              {t('securityNoticeTitle')}
            </Text>
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {[t('authSecurityTip1'), t('authSecurityTip2'), t('authSecurityTip3')].map((item) => (
              <Box
                key={item}
                style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-accent-success)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6L9 17L4 12" />
                </svg>
                <Text size="sm" color="secondary">
                  {item}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>

        <Button
          variant="text"
          onClick={() => navigateWithinViewer('/settings')}
          style={{ marginTop: tokens.spacing[4] }}
        >
          ← {t('returnToSettings')}
        </Button>
      </Box>
    </Box>
  )
}

export default function ExchangeAuthPage() {
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
          <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
            <Text size="lg">{staticT('loading')}</Text>
          </Box>
        </Box>
      }
    >
      <ExchangeAuthContent key={scopeKey} auth={auth} />
    </Suspense>
  )
}
