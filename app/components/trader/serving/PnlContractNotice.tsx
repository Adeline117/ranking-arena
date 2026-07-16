'use client'

import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { GmxRealizedNetDisclosure } from '@/lib/data/serving/pnl-contract'

const LOCALES = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
} as const

export interface PnlContractNoticeProps {
  disclosure: GmxRealizedNetDisclosure
  compact?: boolean
}

export default function PnlContractNotice({ disclosure, compact = false }: PnlContractNoticeProps) {
  const { language, t } = useLanguage()
  const cutoffIso = new Date(disclosure.windowTo * 1000).toISOString()
  const cutoff = new Intl.DateTimeFormat(LOCALES[language], {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(cutoffIso))

  return (
    <Box
      role="note"
      aria-label={t('gmxRealizedNetPnlSummary')}
      style={{
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        alignItems: compact ? 'baseline' : 'flex-start',
        flexWrap: 'wrap',
        gap: compact ? tokens.spacing[1] : 2,
        marginTop: compact ? tokens.spacing[1] : tokens.spacing[2],
      }}
    >
      <Text size="xs" color="tertiary">
        {t('gmxRealizedNetPnlSummary')}
      </Text>
      <Text size="xs" color="tertiary">
        {compact ? '· ' : ''}
        {t('gmxCompletedWindowEnded')}{' '}
        <time dateTime={cutoffIso} suppressHydrationWarning>
          {cutoff} UTC
        </time>
      </Text>
    </Box>
  )
}
