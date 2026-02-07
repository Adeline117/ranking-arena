'use client'

import { useState, useEffect, useTransition } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * Apply theme with smooth transition
 * Uses View Transition API (Chrome 111+) with CSS class fallback
 */
function applyThemeWithTransition(newTheme: 'dark' | 'light') {
  const doc = document.documentElement

  const apply = () => {
    doc.setAttribute('data-theme', newTheme)
    localStorage.setItem('theme', newTheme)
    window.dispatchEvent(new CustomEvent('themeChange', { detail: newTheme }))
  }

  // Modern: View Transition API
  if ('startViewTransition' in document && typeof (document as any).startViewTransition === 'function') {
    (document as any).startViewTransition(() => {
      apply()
    })
    return
  }

  // Fallback: CSS transition class
  doc.classList.add('theme-transition')
  apply()
  // Remove transition class after animation completes to avoid perf overhead
  setTimeout(() => {
    doc.classList.remove('theme-transition')
  }, 450)
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [isPending, startTransition] = useTransition()
  const { t } = useLanguage()

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'dark' | 'light' | null
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.setAttribute('data-theme', savedTheme)
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const defaultTheme = prefersDark ? 'dark' : 'light'
      setTheme(defaultTheme)
      document.documentElement.setAttribute('data-theme', defaultTheme)
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'

    applyThemeWithTransition(newTheme)

    startTransition(() => {
      setTheme(newTheme)
    })
  }

  return (
    <button
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')}
      title={theme === 'dark' ? t('lightMode') : t('darkMode')}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        padding: 0,
        background: 'transparent',
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        color: tokens.colors.text.secondary,
        cursor: isPending ? 'wait' : 'pointer',
        transition: `all ${tokens.transition.fast}`,
        opacity: isPending ? 0.6 : 1,
      }}
    >
      {theme === 'dark' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}
