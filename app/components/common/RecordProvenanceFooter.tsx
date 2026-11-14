'use client'

import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { RecordProvenance } from '@/lib/data/serving/types'
import { formatTimeAgo } from '@/lib/utils/date'
import { describeDataTime } from '@/lib/utils/data-time'

export interface RecordProvenanceFooterProps {
  provenance: RecordProvenance
  exchangeName?: string
}

function ProvenanceTime({
  timestamp,
  language,
}: {
  timestamp: string
  language: 'en' | 'zh' | 'ja' | 'ko'
}) {
  return (
    <time
      dateTime={timestamp}
      title={new Date(timestamp).toLocaleString()}
      suppressHydrationWarning
    >
      {formatTimeAgo(timestamp, language)}
    </time>
  )
}

/** Record-specific provenance: never labels an observation/publication clock
 * as the upstream data's as-of time. */
export default function RecordProvenanceFooter({
  provenance,
  exchangeName,
}: RecordProvenanceFooterProps) {
  const { t, language } = useLanguage()
  const name = exchangeName || provenance.source
  // An epoch/invalid clock is unknown, never a real age.
  const sourceTime = describeDataTime(provenance.sourceAsOf)
  const observedTime = describeDataTime(provenance.observedAt)

  return (
    <div
      data-record-provenance
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        marginTop: tokens.spacing[2],
        flexWrap: 'wrap',
      }}
    >
      <Text size="xs" color="tertiary">
        {t('provenanceSource')}: {name} · {t('recordProvenanceSourceAsOf')}{' '}
        {sourceTime.iso ? (
          <ProvenanceTime timestamp={sourceTime.iso} language={language} />
        ) : (
          t('recordProvenanceUnknown')
        )}
        {sourceTime.isStale && (
          <span
            data-testid="record-provenance-stale"
            suppressHydrationWarning
            style={{ color: tokens.colors.accent.warning }}
          >
            {' ('}
            {t('dataStaleWarning')}
            {')'}
          </span>
        )}
        {' · '}
        {t('recordProvenanceObservedAt')}{' '}
        {observedTime.iso ? (
          <ProvenanceTime timestamp={observedTime.iso} language={language} />
        ) : (
          t('recordProvenanceUnknown')
        )}
      </Text>
    </div>
  )
}
