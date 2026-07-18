'use client'

import React from 'react'
import { Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { buildCompareUrl, type CompareAccountRef } from '@/lib/compare/identity'

interface ShareCompareButtonProps {
  accounts: CompareAccountRef[]
  traderNames?: string[]
  comparisonRef?: React.RefObject<HTMLDivElement | null>
}

export default function ShareCompareButton({ accounts, traderNames }: ShareCompareButtonProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()

  const handleShare = () => {
    const url = `${window.location.origin}${buildCompareUrl(accounts)}`
    const text =
      traderNames && traderNames.length > 0
        ? `Comparing ${traderNames.join(' vs ')} on Arena\n\n${url}`
        : `Trader comparison on Arena\n\n${url}`

    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      /Mobi|Android/i.test(navigator.userAgent)
    ) {
      navigator.share({ title: 'Trader Comparison', text, url }).catch((_err) => {
        // user cancelled
      })
    } else {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          showToast(t('compareShareCopied'), 'success')
        })
        .catch((_err) => {
          console.warn('[ShareCompareButton] clipboard failed')
        })
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleShare}>
      {t('compareShareBtn')}
    </Button>
  )
}
