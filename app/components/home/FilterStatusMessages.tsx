'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box } from '../base'

interface FilterStatusMessagesProps {
  loading: boolean
  language: string
  selectedExchange: string | null
  advancedFilteredCount: number
}

export default function FilterStatusMessages({
  loading,
  language: _language,
  selectedExchange,
  advancedFilteredCount,
}: FilterStatusMessagesProps) {
  const { t } = useLanguage()
  return (
    <>
      {/* Exchange trader count hint. (The former "all traders filtered out"
          prompt depended on an exact total that is never available; the
          filtered empty state + reset now lives in RankingTable.) */}
      {!loading && selectedExchange && advancedFilteredCount > 0 && advancedFilteredCount < 20 && (
        <Box
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            marginBottom: tokens.spacing[2],
            textAlign: 'center',
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
            background: tokens.glass.bg.light,
            borderRadius: tokens.radius.md,
          }}
        >
          {t('tradersOnExchange').replace('{count}', String(advancedFilteredCount))}
        </Box>
      )}
    </>
  )
}
