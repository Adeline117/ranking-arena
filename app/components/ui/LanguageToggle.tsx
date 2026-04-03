'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SUPPORTED_LANGUAGES, Language } from '@/lib/i18n'

const LANG_LABELS: Record<Language, string> = {
  en: 'EN',
  zh: '中',
  ja: '日',
  ko: '한',
}

export default function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage()
  const [isChanging, setIsChanging] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const switchLanguage = useCallback((newLang: Language) => {
    if (isChanging || newLang === language) {
      setIsOpen(false)
      return
    }
    setIsChanging(true)
    setIsOpen(false)

    const main = document.getElementById('main-content')
    const target = main || document.body
    target.style.transition = 'opacity 0.12s ease-out'
    target.style.opacity = '0.7'

    requestAnimationFrame(() => {
      setLanguage(newLang)
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
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={t('switchLanguage')}
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
        {LANG_LABELS[language] || 'EN'}
      </button>
      {isOpen && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          overflow: 'hidden',
          zIndex: 50,
          minWidth: 120,
          boxShadow: '0 4px 12px var(--color-overlay-medium, rgba(0,0,0,0.3))',
        }}>
          {SUPPORTED_LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => switchLanguage(lang.code)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                background: lang.code === language ? 'var(--color-accent-primary-15, rgba(124,58,237,0.15))' : 'transparent',
                border: 'none',
                color: lang.code === language ? 'var(--color-accent-primary, #a78bfa)' : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                if (lang.code !== language) e.currentTarget.style.background = 'var(--color-bg-tertiary, rgba(255,255,255,0.05))'
              }}
              onMouseLeave={(e) => {
                if (lang.code !== language) e.currentTarget.style.background = 'transparent'
              }}
            >
              <span style={{ fontWeight: 600, width: 24 }}>{LANG_LABELS[lang.code]}</span>
              <span>{lang.nativeLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
