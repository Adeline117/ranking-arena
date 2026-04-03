'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { t as staticT } from '@/lib/i18n'

const EXCHANGES = [
  { id: 'binance', name: 'Binance', oauthSupported: true },
  { id: 'bybit', name: 'Bybit', oauthSupported: true },
  { id: 'bitget', name: 'Bitget', oauthSupported: false },
  { id: 'mexc', name: 'MEXC', oauthSupported: false },
  { id: 'htx', name: 'HTX', oauthSupported: false },
  { id: 'weex', name: 'Weex', oauthSupported: false },
  { id: 'coinex', name: 'CoinEx', oauthSupported: false },
] as const

function ExchangeAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const exchangeParam = searchParams.get('exchange')
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.push('/login?redirect=/exchange/auth')
        return
      }
      setUserId(data.user.id)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for exchange auth page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [router])

  const handleOAuth = async (exchange: string) => {
    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login?redirect=/exchange')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // 获取 OAuth 授权 URL
      const response = await fetch(`/api/exchange/oauth/authorize?exchange=${exchange}&userId=${userId}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get OAuth URL')
      }

      // 重定向到交易所 OAuth 页面
      window.location.href = data.authUrl
    } catch (err: unknown) {
      setError(t('authorizationFailed'))
      setLoading(false)
    }
  }

  const handleApiKey = (exchange: string) => {
    router.push(`/exchange/auth/api-key?exchange=${exchange}`)
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  const selectedExchange = EXCHANGES.find(e => e.id === exchangeParam)

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          {t('bindExchangeAccount')}
        </Text>

        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              background: `${tokens.colors.accent.error}20`,
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
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
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
                  {loading ? t('authorizing') : t('useOAuthAuthorize').replace('{exchange}', selectedExchange.name)}
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
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <Text size="lg" weight="bold">
              {t('securityNoticeTitle')}
            </Text>
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {[
              t('authSecurityTip1'),
              t('authSecurityTip2'),
              t('authSecurityTip3'),
            ].map((item) => (
              <Box key={item} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17L4 12" />
                </svg>
                <Text size="sm" color="secondary">{item}</Text>
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
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg">{staticT('loading')}</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthContent />
    </Suspense>
  )
}
