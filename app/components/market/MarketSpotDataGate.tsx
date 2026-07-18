'use client'

import type { ReactNode } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ErrorState from '@/app/components/ui/ErrorState'
import { tokens } from '@/lib/design-tokens'

export default function MarketSpotDataGate({
  pending,
  failed,
  retry,
  height,
  children,
}: {
  pending: boolean
  failed: boolean
  retry: () => void
  height: number
  children: ReactNode
}) {
  const { t } = useLanguage()

  if (pending) {
    return (
      <div
        data-testid="market-spot-loading"
        className="skeleton"
        style={{ height, borderRadius: tokens.radius.md }}
      />
    )
  }

  if (failed) {
    return (
      <ErrorState
        title={t('marketDataError')}
        description={t('loadFailedRetryShort')}
        retry={retry}
        variant="compact"
      />
    )
  }

  return children
}
