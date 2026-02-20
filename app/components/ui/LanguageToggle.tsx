'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage()
  const [isChanging, setIsChanging] = useState(false)

  const toggleLanguage = useCallback(() => {
    if (isChanging) return
    setIsChanging(true)
    const newLang = language === 'zh' ? 'en' : 'zh'

    // Smooth language switch: brief opacity dip to mask text reflow
    const main = document.getElementById('main-content')
    const target = main || document.body
    target.style.transition = 'opacity 0.12s ease-out'
    target.style.opacity = '0.7'
    
    // Apply language change at the opacity trough
    requestAnimationFrame(() => {
      setLanguage(newLang)
      // Fade back in
      requestAnimationFrame(() => {
        target.style.opacity = '1'
        setTimeout(() => {
          target.style.transition = ''
          setIsChanging(false)
        }, 180)
      })
    })
  }, [isChanging, language, setLanguage])

  return (
    <button
      onClick={toggleLanguage}
      aria-label={language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}
      title={language === 'zh' ? t('switchToEnglish') : t('switchToChinese')}
      disabled={isChanging}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 44,
        height: 44,
        padding: `0 ${tokens.spacing[2]}`,
        background: 'transparent',
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        color: tokens.colors.text.secondary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.medium,
        cursor: isChanging ? 'wait' : 'pointer',
        transition: `all ${tokens.transition.fast}`,
        opacity: isChanging ? 0.7 : 1,
      }}
    >
      {language === 'zh' ? 'EN' : '中'}
    </button>
  )
}
