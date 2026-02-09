'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

function ExchangeAuthorizePageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [exchange, setExchange] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [instructions, setInstructions] = useState<string[]>([])
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })

    const exchangeParam = searchParams.get('exchange')
    if (!exchangeParam) {
      router.push('/settings')
      return
    }

    setExchange(exchangeParam)
    loadAuthUrl(exchangeParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router])

  const loadAuthUrl = async (ex: string) => {
    try {
      setLoading(true)
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login?redirect=/exchange')
        return
      }

      const response = await fetch(`/api/exchange/authorize?exchange=${ex}&userId=${session.user.id}`)
      const result = await response.json()

      if (!response.ok) {
        showToast(result.error || t('loadAuthPageFailed'), 'error')
        router.push('/settings')
        return
      }

      setAuthUrl(result.authUrl)
      setInstructions(result.instructions || [])
    } catch (error: unknown) {
      logger.error('[ExchangeAuthorize] Load failed:', error)
      showToast(t('loadFailedRetryShort'), 'error')
      router.push('/settings')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenAuth = () => {
    if (!authUrl) return

    window.open(authUrl, '_blank', 'width=800,height=600')
  }

  const handleBack = () => {
    router.push('/settings')
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  const exchangeName = exchange?.toUpperCase() || 'Exchange'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          {t('bindExchangeAccountTitle').replace('{exchange}', exchangeName)}
        </Text>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            {t('authSteps')}
          </Text>

          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[6] }}>
            {instructions.map((instruction, index) => (
              <Box
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[2],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                }}
              >
                <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary, minWidth: 20 }}>
                  {index + 1}.
                </Text>
                <Text size="sm" style={{ flex: 1 }}>
                  {instruction}
                </Text>
              </Box>
            ))}
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
            <Button
              variant="primary"
              onClick={handleOpenAuth}
            >
              {t('openAuthPage').replace('{exchange}', exchangeName)}
            </Button>
            <Button
              variant="secondary"
              onClick={handleBack}
            >
              {t('returnToSettings')}
            </Button>
          </Box>
        </Box>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            {t('importantNotice')}
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Text size="sm" color="tertiary">
              {`\u2022 ${t('authReadOnlyTip')}`}
            </Text>
            <Text size="sm" color="tertiary">
              {`\u2022 ${t('authEncryptedTip')}`}
            </Text>
            <Text size="sm" color="tertiary">
              {`\u2022 ${t('authExistingKeyTip')}`}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default function ExchangeAuthorizePage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">Loading...</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthorizePageContent />
    </Suspense>
  )
}
