'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage()
  const [isChanging, setIsChanging] = useState(false)

  const toggleLanguage = () => {
    if (isChanging) return
    setIsChanging(true)
    const newLang = language === 'zh' ? 'en' : 'zh'
    setLanguage(newLang)
    // Brief delay for visual feedback, then reset
    setTimeout(() => setIsChanging(false), 300)
  }

  return (
    <button
      onClick={toggleLanguage}
      aria-label={language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}
      title={language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 36,
        height: 36,
        padding: `0 ${tokens.spacing[2]}`,
        background: 'transparent',
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        color: tokens.colors.text.secondary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.medium,
        cursor: 'pointer',
        transition: `all ${tokens.transition.fast}`,
      }}
    >
      {language === 'zh' ? 'EN' : '中'}
    </button>
  )
}


