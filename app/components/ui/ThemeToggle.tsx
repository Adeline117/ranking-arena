'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [animating, setAnimating] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { t } = useLanguage()

  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | null
    const initial = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  const toggleTheme = () => {
    if (animating) return
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    const btn = btnRef.current

    // Try View Transition API with circular clip-path animation
    if (btn && 'startViewTransition' in document && typeof (document as any).startViewTransition === 'function') {
      const rect = btn.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      // Calculate max radius to cover entire viewport
      const maxRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      )

      setAnimating(true)

      const transition = (document as any).startViewTransition(() => {
        document.documentElement.setAttribute('data-theme', newTheme)
        localStorage.setItem('theme', newTheme)
        setTheme(newTheme)
      })

      transition.ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${maxRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 500,
            easing: 'ease-in-out',
            pseudoElement: '::view-transition-new(root)',
          }
        )
      }).catch(() => {
        // Animation failed, theme still applied
      })

      transition.finished.then(() => {
        setAnimating(false)
      }).catch(() => {
        setAnimating(false)
      })

      return
    }

    // Fallback: instant switch, no animation
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('theme', newTheme)
    setTheme(newTheme)
  }

  return (
    <button
      ref={btnRef}
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
        cursor: animating ? 'wait' : 'pointer',
        transition: `all ${tokens.transition.fast}`,
        opacity: animating ? 0.7 : 1,
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
