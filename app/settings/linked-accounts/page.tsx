'use client'

import React, { Suspense, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { TraderLinksSection } from '../components/TraderLinksSection'
import { logger } from '@/lib/logger'

function LinkedAccountsContent() {
  const router = useRouter()
  const { t } = useLanguage()
  const [userId, setUserId] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      if (!data.user) {
        router.push('/login?redirect=/settings/linked-accounts')
        return
      }
      setUserId(data.user.id)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [router])

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box style={{ width: 32, height: 32, border: `3px solid ${tokens.colors.border.primary}`, borderTopColor: tokens.colors.accent.primary, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <Text size="lg" color="secondary">{t('loading')}</Text>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </Box>
      </Box>
    )
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 400, margin: '0 auto', padding: tokens.spacing[8], textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[4] }}>
          <Box style={{ width: 64, height: 64, borderRadius: tokens.radius.full, background: `${tokens.colors.accent.primary}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </Box>
          <Text size="xl" weight="bold">{t('loginRequired')}</Text>
          <Text size="sm" color="secondary">{t('loginRequiredDesc')}</Text>
          <Button variant="primary" onClick={() => router.push('/login?redirect=/settings/linked-accounts')}>{t('goToLogin')}</Button>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 800, margin: '0 auto', paddingLeft: tokens.spacing[6], paddingRight: tokens.spacing[6] }}>
        <Breadcrumb items={[
          { label: t('settings'), href: '/settings' },
          { label: t('linkedAccounts') },
        ]} />
      </Box>

      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], paddingTop: 0, paddingBottom: 100 }}>
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
            {t('linkedAccounts')}
          </Text>
          <Text size="sm" color="tertiary" style={{ lineHeight: 1.6 }}>
            {t('myTraderAccountsDesc')}
          </Text>
        </Box>

        <Box style={{
          padding: tokens.spacing[6],
          borderRadius: tokens.radius['2xl'],
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md,
          border: tokens.glass.border.light,
          boxShadow: tokens.shadow.md,
        }}>
          <TraderLinksSection userId={userId} />
        </Box>

        {/* Back to settings link */}
        <Box style={{ marginTop: tokens.spacing[6], textAlign: 'center' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/settings')}
            style={{ color: tokens.colors.text.tertiary }}
          >
            &larr; {t('settings')}
          </Button>
        </Box>
      </Box>

      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}

export default function LinkedAccountsPage() {
  return (
    <ErrorBoundary
      pageType="profile"
      onError={(error, errorInfo) => {
        logger.error('LinkedAccounts page error:', { error: String(error), componentStack: errorInfo?.componentStack })
      }}
    >
      <Suspense fallback={
        <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
          <TopNav email={null} />
          <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {[1, 2, 3].map(i => (
                <Box key={i} style={{ height: 120, borderRadius: tokens.radius.xl, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </Box>
          </Box>
        </Box>
      }>
        <LinkedAccountsContent />
      </Suspense>
    </ErrorBoundary>
  )
}
