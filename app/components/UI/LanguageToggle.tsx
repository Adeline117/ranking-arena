'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

export default function LanguageToggle() {
  const { language, setLanguage } = useLanguage()

  const toggleLanguage = () => {
    setLanguage(language === 'zh' ? 'en' : 'zh')
  }

  return (
    <button
      onClick={toggleLanguage}
      aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}
      title={language === 'zh' ? 'Switch to English' : '切换到中文'}
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

