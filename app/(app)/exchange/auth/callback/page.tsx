'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function ExchangeAuthCallbackContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get('code')
      const state = searchParams.get('state')
      const exchange = searchParams.get('exchange')
      const error = searchParams.get('error')

      if (error) {
        setStatus('error')
        setMessage(t('authFailedPrefix').replace('{error}', error))
        return
      }

      if (!code || !state || !exchange) {
        setStatus('error')
        setMessage(t('missingAuthParams'))
        return
      }

      try {
         
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setStatus('error')
          setMessage(t('pleaseLogin'))
          router.push('/login')
          return
        }

        const response = await fetch('/api/exchange/oauth/callback', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getCsrfHeaders()
          },
          body: JSON.stringify({
            exchange,
            code,
            state,
            userId: user.id,
          }),
        })

        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || t('authorizationFailed'))
        }

        setStatus('success')
        setMessage(t('authorizationSuccessRedirecting'))

        setTimeout(() => {
          router.push('/settings')
        }, 3000)
      } catch (err) {
        setStatus('error')
        const errorMessage = err instanceof Error ? err.message : t('authorizationFailed')
        setMessage(errorMessage)
      }
    }

    handleCallback()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; t and supabase are stable refs
  }, [searchParams, router])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />

      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10], textAlign: 'center' }}>
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
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.accent.success }}>
              [OK] {t('authorizationSuccess')}
            </Text>
            <Text size="sm" color="secondary">
              {message}
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.accent.error }}>
              [FAIL] {t('authorizationFailed')}
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {message}
            </Text>
            <button
              onClick={() => router.push('/exchange/auth')}
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
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10], textAlign: 'center' }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthCallbackContent />
    </Suspense>
  )
}
