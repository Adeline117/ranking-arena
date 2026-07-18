'use client'

import { useCallback, useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { bootstrapClientAuth } from '@/lib/auth/client-auth-bootstrap'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ErrorState from '@/app/components/ui/ErrorState'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { t as staticT } from '@/lib/i18n'
import { EXCHANGE_BIND_LIST } from './api-key/exchange-configs'
import { readCurrentOAuthAccessToken, requestExchangeOAuthUrl } from './oauth-client'

// Single source of truth: display names + OAuth capability live in exchange-configs.
const EXCHANGES = EXCHANGE_BIND_LIST

interface ExchangeAuthScope {
  userId: string
}

function ExchangeAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const push = router.push
  const { showToast } = useToast()
  const { t } = useLanguage()
  const exchangeParam = searchParams.get('exchange')
  const [authScope, setAuthScope] = useState<ExchangeAuthScope | null>(null)
  const [authStatus, setAuthStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadAuth = useCallback(async () => {
    setAuthStatus('loading')
    setAuthScope(null)
    const result = await bootstrapClientAuth(supabase.auth)

    if (result.status === 'signed-out') {
      push('/login?redirect=/exchange/auth')
      return
    }
    if (result.status === 'error') {
      setAuthStatus('error')
      return
    }

    if (!result.session?.access_token) {
      setAuthStatus('error')
      return
    }

    setAuthScope({ userId: result.user.id })
    setAuthStatus('ready')
  }, [push])

  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  const handleOAuth = async (exchange: string) => {
    if (!authScope) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login?redirect=/exchange')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const accessToken = await readCurrentOAuthAccessToken(
        () => supabase.auth.getSession(),
        authScope.userId
      )
      // 重定向到交易所 OAuth 页面
      window.location.href = await requestExchangeOAuthUrl(exchange, accessToken)
    } catch (_err: unknown) {
      setError(t('authorizationFailed'))
      setLoading(false)
    }
  }

  const handleApiKey = (exchange: string) => {
    router.push(`/exchange/auth/api-key?exchange=${exchange}`)
  }

  if (authStatus === 'error') {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <ErrorState
            title={t('somethingWentWrong')}
            description={t('loadFailedRetryShort')}
            retry={() => void loadAuth()}
            variant="compact"
          />
        </Box>
      </Box>
    )
  }

  if (authStatus === 'loading' || !authScope) {
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
                  onClick={() => router.push(`/exchange/auth?exchange=${exchange.id}`)}
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
          onClick={() => router.push('/settings')}
          style={{ marginTop: tokens.spacing[4] }}
        >
          ← {t('returnToSettings')}
        </Button>
      </Box>
    </Box>
  )
}

export default function ExchangeAuthPage() {
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
      <ExchangeAuthContent />
    </Suspense>
  )
}
