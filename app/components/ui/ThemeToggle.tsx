'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type ThemePreference = 'dark' | 'light' | 'system'

/** Resolve the effective theme (dark/light) from a preference value. */
function resolveEffectiveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'system') {
    if (typeof window === 'undefined') return 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

export default function ThemeToggle() {
  // preference tracks what the user chose (dark / light / system)
  const [preference, setPreference] = useState<ThemePreference>('system')
  // effective tracks the actual applied theme (dark / light)
  const [effective, setEffective] = useState<'dark' | 'light'>('dark')
  const [animating, setAnimating] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { t } = useLanguage()

  // Initialise from localStorage; default new users to "system"
  useEffect(() => {
    const saved = localStorage.getItem('theme') as ThemePreference | null
    const pref: ThemePreference = saved || 'system'
    const eff = resolveEffectiveTheme(pref)
    setPreference(pref)
    setEffective(eff)
    document.documentElement.setAttribute('data-theme', eff)
  }, [])

  // When preference is "system", listen for OS-level changes and auto-switch
  useEffect(() => {
    if (preference !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const newEff = e.matches ? 'dark' : 'light'
      setEffective(newEff)
      document.documentElement.setAttribute('data-theme', newEff)
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [preference])

  const applyTheme = useCallback((newPref: ThemePreference) => {
    const newEffective = resolveEffectiveTheme(newPref)
    const btn = btnRef.current

    // Try View Transition API with circular clip-path animation
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }
    if (btn && doc.startViewTransition && newEffective !== effective) {
      const rect = btn.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      // Calculate max radius to cover entire viewport
      const maxRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      )

      setAnimating(true)

      const transition = doc.startViewTransition!(() => {
        document.documentElement.setAttribute('data-theme', newEffective)
        localStorage.setItem('theme', newPref)
        setPreference(newPref)
        setEffective(newEffective)
      })

      transition.ready.then(() => {
        // Enhance circular reveal animation with better easing
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${maxRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 600,
            easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', // More polished easing
            pseudoElement: '::view-transition-new(root)',
          }
        )
      }).catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
        // Animation failed, theme still applied
      })

      transition.finished.then(() => {
        setAnimating(false)
      }).catch(() => {
        setAnimating(false)
      })

      return
    }

    // Fallback: CSS transition for browsers without View Transitions API
    if (newEffective !== effective) {
      setAnimating(true)
      document.documentElement.classList.add('theme-transition')
      setTimeout(() => {
        document.documentElement.setAttribute('data-theme', newEffective)
        localStorage.setItem('theme', newPref)
        setPreference(newPref)
        setEffective(newEffective)
        setTimeout(() => {
          document.documentElement.classList.remove('theme-transition')
          setAnimating(false)
        }, 400)
      }, 50)
    } else {
      // Same effective theme (e.g. switching to "system" when OS matches current)
      localStorage.setItem('theme', newPref)
      setPreference(newPref)
      setEffective(newEffective)
    }
  }, [effective])

  // Cycle: dark -> light -> system -> dark
  const cycleTheme = () => {
    if (animating) return
    const next: ThemePreference =
      preference === 'dark' ? 'light'
      : preference === 'light' ? 'system'
      : 'dark'
    applyTheme(next)
  }

  const getLabel = (): string => {
    if (preference === 'system') return t('systemMode')
    return preference === 'dark' ? t('darkMode') : t('lightMode')
  }

  // Icons: sun = currently dark (click to go light), moon = currently light, monitor = system
  const renderIcon = () => {
    if (preference === 'system') {
      // Monitor/desktop icon for system mode
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )
    }
    if (effective === 'dark') {
      // Sun icon — current is dark, next step goes toward light
      return (
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
      )
    }
    // Moon icon — current is light
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    )
  }

  return (
    <button
      ref={btnRef}
      onClick={cycleTheme}
      aria-label={getLabel()}
      title={getLabel()}
      disabled={animating}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        padding: 0,
        background: 'transparent',
        border: `1px solid var(--color-border-primary)`,
        borderRadius: tokens.radius.md,
        color: 'var(--color-text-secondary)',
        cursor: animating ? 'wait' : 'pointer',
        transition: `all ${tokens.transition.fast}`,
        opacity: animating ? 0.7 : 1,
        transform: animating ? 'scale(0.95)' : 'scale(1)',
      }}
      onMouseEnter={(e) => {
        if (!animating) {
          e.currentTarget.style.background = 'var(--color-bg-secondary)'
          e.currentTarget.style.color = 'var(--color-text-primary)'
          e.currentTarget.style.borderColor = 'var(--color-accent-primary)'
        }
      }}
      onMouseLeave={(e) => {
        if (!animating) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--color-text-secondary)'
          e.currentTarget.style.borderColor = 'var(--color-border-primary)'
        }
      }}
    >
      {renderIcon()}
    </button>
  )
}
