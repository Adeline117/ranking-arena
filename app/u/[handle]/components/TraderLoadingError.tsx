'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface TraderLoadingProps {
  email: string | null
}

export function TraderLoading({ email }: TraderLoadingProps) {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        <RankingSkeleton />
      </Box>
    </Box>
  )
}

interface TraderErrorProps {
  email: string | null
}

export function TraderError({ email }: TraderErrorProps) {
  const { t } = useLanguage()

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('loadFailedRetryMsg')}
        </Text>
        <Link href="/" style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontSize: tokens.typography.fontSize.sm }}>
          {t('backToHome')}
        </Link>
      </Box>
    </Box>
  )
}
