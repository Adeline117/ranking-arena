'use client'

/**
 * Provenance footer (spec §6, REQUIRED on every board and profile):
 * "{Exchange} · as of {relative time}". Timestamps are stored UTC and
 * converted to the viewer's locale ONLY here at render (spec §5.9).
 * Derived boards additionally carry the coverage-bias badge.
 */

import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import type { Provenance } from '@/lib/data/serving/types'
import DerivedBoardBadge from './DerivedBoardBadge'

export interface ProvenanceFooterProps {
  provenance: Provenance
  /** Display name; falls back to the source slug. */
  exchangeName?: string
  style?: React.CSSProperties
}

export default function ProvenanceFooter({
  provenance,
  exchangeName,
  style,
}: ProvenanceFooterProps) {
  const { t, language } = useLanguage()
  const name = exchangeName || provenance.source

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        marginTop: tokens.spacing[2],
        ...style,
      }}
    >
      <Text size="xs" color="tertiary" style={{ opacity: 0.75 }}>
        {t('provenanceSource')}: {name} · {t('provenanceAsOf')}{' '}
        <time dateTime={provenance.asOf} title={new Date(provenance.asOf).toLocaleString()}>
          {formatTimeAgo(provenance.asOf, language)}
        </time>
      </Text>
      {provenance.derived && <DerivedBoardBadge />}
    </div>
  )
}
