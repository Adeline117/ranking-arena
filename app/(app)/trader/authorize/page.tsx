'use client'

/**
 * Trader Authorization Page
 * Now redirects to the unified /claim page.
 * Authorization (live data sync) is automatically triggered when a claim is verified.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function TraderAuthorizePage() {
  const router = useRouter()
  const { t } = useLanguage()

  useEffect(() => {
    // Redirect to the unified claim page after a brief delay
    const timer = setTimeout(() => {
      router.replace('/claim')
    }, 2000)
    return () => clearTimeout(timer)
  }, [router])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopNav />
      <Box style={{
        padding: tokens.spacing[6],
        maxWidth: '600px',
        margin: '0 auto',
        textAlign: 'center',
      }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], marginBottom: tokens.spacing[3] }}>
          {t('authorizeRealData')}
        </h1>
        <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4] }}>
          {t('authorizeDesc')}
        </p>
        <p style={{ color: tokens.colors.text.tertiary }}>
          Redirecting to the unified Claim flow...
        </p>
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}
