'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ProfileNotFoundProps {
  handle: string
  email: string | null
}

export default function ProfileNotFound({ handle, email }: ProfileNotFoundProps) {
  const { t } = useLanguage()

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
        <Box
          style={{
            width: 80, height: 80, borderRadius: '50%',
            background: tokens.colors.bg.secondary,
            border: `2px solid ${tokens.colors.border.primary}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto', marginBottom: tokens.spacing[4],
          }}
        >
          <Text size="2xl" weight="bold" color="tertiary">
            {handle?.charAt(0)?.toUpperCase() || '?'}
          </Text>
        </Box>
        <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          @{handle}
        </Text>
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {t('userNotRegistered')}
        </Text>
        <Link
          href="/"
          style={{
            color: tokens.colors.accent.brand,
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('backToHome')}
        </Link>
      </Box>
    </Box>
  )
}
