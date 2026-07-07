'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'

export function StatsSection() {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: tokens.spacing[8],
        marginBottom: tokens.spacing[8],
        padding: `${tokens.spacing[5]} 0`,
      }}
    >
      <Box style={{ textAlign: 'center' }}>
        <Text
          style={{
            fontSize: tokens.typography.fontSize['3xl'],
            fontWeight: 800,
            color: tokens.colors.accent.primary,
          }}
        >
          {/* U2-10: harmonized to match the "8,000+" figure in claimPageSubtitle
              (was "8K+", a third distinct format on the same page). Kept as the
              existing stable value — not a newly-invented serving count. */}
          8,000+
        </Text>
        <Text
          style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.sm }}
        >
          {t('claimPageTotalTraders')}
        </Text>
      </Box>
    </Box>
  )
}
