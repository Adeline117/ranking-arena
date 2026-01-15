'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Utils/LanguageProvider'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'

interface AdditionalStatsProps {
  data: TraderStats['additionalStats']
}

export default function AdditionalStats({ data }: AdditionalStatsProps) {
  const { t, language } = useLanguage()
  if (!data) return null

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[6] }}>
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        {t('additionalStats')}
      </Text>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: tokens.spacing[4],
        }}
      >
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {t('tradesPerWeek')}
          </Text>
          <Text size="lg" weight="bold">
            {data.tradesPerWeek !== undefined ? data.tradesPerWeek.toFixed(2) : t('na')}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {t('avgHoldingTime')}
          </Text>
          <Text size="lg" weight="bold">
            {data.avgHoldingTime || t('na')}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {language === 'zh' ? t('trackedSinceCn') : t('trackedSince')}
          </Text>
          <Text size="lg" weight="bold">
            {data.activeSince || t('na')}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {t('profitableWeeks')}
          </Text>
          <Text size="lg" weight="bold" style={{ color: '#7CFFB2' }}>
            {data.profitableWeeksPct !== undefined ? data.profitableWeeksPct.toFixed(2) : t('na')}%
          </Text>
        </Box>
      </Box>
    </Box>
  )
}







