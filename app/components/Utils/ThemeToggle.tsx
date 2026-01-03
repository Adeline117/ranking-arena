'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { SunIcon, MoonIcon } from '../Icons'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | null
    const current = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    setTheme(current)
    document.documentElement.setAttribute('data-theme', current)
    
    // Dispatch event for theme change
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: current } }))
  }, [])

  useEffect(() => {
    if (!mounted) return
    
    const handleThemeChange = () => {
      // Force re-render by updating state
      const current = document.documentElement.getAttribute('data-theme') as 'dark' | 'light'
      setTheme(current || 'dark')
    }
    
    window.addEventListener('themechange', handleThemeChange as EventListener)
    return () => window.removeEventListener('themechange', handleThemeChange as EventListener)
  }, [mounted])

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: newTheme } }))
  }

  if (!mounted) {
    return (
      <button
        style={{
          padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          cursor: 'pointer',
          width: 36,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MoonIcon size={16} style={{ color: tokens.colors.text.secondary }} />
      </button>
    )
  }

  return (
    <button
      onClick={toggleTheme}
      style={{
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
        color: tokens.colors.text.primary,
        cursor: 'pointer',
        width: 36,
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: `background-color ${tokens.transition.fast}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.colors.bg.tertiary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tokens.colors.bg.secondary
      }}
      title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
    >
      {theme === 'dark' ? (
        <SunIcon size={16} style={{ color: tokens.colors.text.primary }} />
      ) : (
        <MoonIcon size={16} style={{ color: tokens.colors.text.primary }} />
      )}
    </button>
  )
}

