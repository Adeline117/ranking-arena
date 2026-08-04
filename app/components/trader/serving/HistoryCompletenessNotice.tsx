'use client'

import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { alpha, tokens } from '@/lib/design-tokens'
import type { HistoryCompleteness } from '@/lib/data/serving/types'

export interface HistoryCompletenessNoticeProps {
  completeness: HistoryCompleteness | null | undefined
}

/**
 * Fail-closed disclosure for a history response that cannot support rankings.
 * Verified-complete history intentionally renders nothing: this notice is only
 * for a limitation users need before interpreting the rows or an empty preview.
 */
export default function HistoryCompletenessNotice({
  completeness,
}: HistoryCompletenessNoticeProps) {
  const { t } = useLanguage()
  if (!completeness || completeness.state === 'complete') return null

  const partial = completeness.state === 'partial'
  const title = t(partial ? 'historyCompletenessPartialTitle' : 'historyCompletenessUnknownTitle')
  const description = t(
    partial ? 'historyCompletenessPartialDescription' : 'historyCompletenessUnknownDescription'
  )

  return (
    <Box
      role="status"
      aria-label={title}
      data-history-completeness={completeness.state}
      data-history-evidence={completeness.evidenceState}
      style={{
        padding: tokens.spacing[3],
        marginBottom: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: alpha(tokens.colors.accent.warning, partial ? 8 : 5),
        border: `1px solid ${alpha(tokens.colors.accent.warning, partial ? 26 : 18)}`,
      }}
    >
      <Text
        size="sm"
        weight="semibold"
        style={{ display: 'block', color: tokens.colors.accent.warning }}
      >
        {title}
      </Text>
      <Text
        size="xs"
        color="tertiary"
        style={{ display: 'block', marginTop: tokens.spacing[1], lineHeight: 1.5 }}
      >
        {description}
      </Text>
    </Box>
  )
}
