'use client'

import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { RecordProvenance } from '@/lib/data/serving/types'
import { formatTimeAgo } from '@/lib/utils/date'

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

/** Record-specific provenance: an observation/publication clock is never
 * labelled as the upstream data's source-as-of time. */
export default function RecordProvenanceFooter({
  provenance,
  exchangeName,
}: RecordProvenanceFooterProps) {
  const { t, language } = useLanguage()
  const name = exchangeName || provenance.source

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
        {provenance.sourceAsOf ? (
          <ProvenanceTime timestamp={provenance.sourceAsOf} language={language} />
        ) : (
          t('recordProvenanceUnknown')
        )}
        {' · '}
        {t('recordProvenanceObservedAt')}{' '}
        {provenance.observedAt ? (
          <ProvenanceTime timestamp={provenance.observedAt} language={language} />
        ) : (
          t('recordProvenanceUnknown')
        )}
      </Text>
    </div>
  )
}
