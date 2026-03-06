'use client'

import React from 'react'
import { Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

interface ShareCompareButtonProps {
  traderIds: string[]
  comparisonRef?: React.RefObject<HTMLDivElement | null>
}

export default function ShareCompareButton({ traderIds }: ShareCompareButtonProps) {
  const { t } = useLanguage()

  const handleShare = () => {
    const url = `${window.location.origin}/compare?ids=${traderIds.join(',')}`
    if (navigator.share) {
      navigator.share({ title: 'Trader Comparison', url }).catch(err => console.warn('[ShareCompareButton] share failed', err))
    } else {
      navigator.clipboard.writeText(url).catch(err => console.warn('[ShareCompareButton] share failed', err))
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleShare}>
      {t('share')}
    </Button>
  )
}
