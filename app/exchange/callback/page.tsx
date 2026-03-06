'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function ExchangeCallbackPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [exchange, setExchange] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      if (!data.user) {
        router.push('/login')
        return
      }
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for exchange callback */ })

    const exchangeParam = searchParams.get('exchange')
    if (exchangeParam) {
      setExchange(exchangeParam)
    } else {
      router.push('/settings')
    }
  }, [searchParams, router])

  const handleConnect = async () => {
    if (!apiKey || !apiSecret) {
      setError(t('enterApiKeyAndSecret'))
      return
    }

    if (!exchange) {
      setError(t('missingExchangeInfo'))
      return
    }

    setError(null)
    setConnecting(true)

    try {
       
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError(t('pleaseLogin'))
        return
      }

      const response = await fetch('/api/exchange/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          exchange,
          apiKey,
          apiSecret,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        setError(result.error || t('connectFailed'))
        return
      }

      showToast(t('bindSuccessSyncing'), 'success')
      router.push('/settings')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('connectFailed')
      setError(errorMessage)
    } finally {
      setConnecting(false)
    }
  }

  const exchangeName = exchange?.toUpperCase() || 'Exchange'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          {t('completeBindTitle').replace('{exchange}', exchangeName)}
        </Text>
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
          {t('enterApiKeyAndSecretDesc')}
        </Text>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
        >
          {error && (
            <Box
              style={{
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: 'var(--color-accent-error-10)',
                border: '1px solid var(--color-accent-error-20)',
                marginBottom: tokens.spacing[4],
              }}
            >
              <Text size="sm" style={{ color: tokens.colors.accent.error }}>{error}</Text>
            </Box>
          )}

          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                API Key
              </Text>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('pasteYourApiKey')}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
                autoFocus
              />
            </Box>

            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                API Secret
              </Text>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={t('pasteYourApiSecret')}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
              />
            </Box>

            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <Button
                variant="primary"
                onClick={handleConnect}
                disabled={connecting || !apiKey || !apiSecret}
                style={{ flex: 1 }}
              >
                {connecting ? t('binding') : t('completeBind2')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => router.push('/settings')}
                disabled={connecting}
              >
                {t('bindLater')}
              </Button>
            </Box>
          </Box>
        </Box>

        <Box
          style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="xs" color="tertiary">
            {t('bindTip').replace('{exchange}', exchangeName)}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

export default function ExchangeCallbackPage() {
  const { t } = useLanguage()
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    }>
      <ExchangeCallbackPageContent />
    </Suspense>
  )
}
