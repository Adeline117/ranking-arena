'use client'

import { useEffect, useState } from 'react'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | null
    const current = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    setTheme(current)
    document.documentElement.setAttribute('data-theme', current)
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  return (
    <button
      onClick={toggleTheme}
      style={{
        padding: '6px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.05)',
        color: '#eaeaea',
        cursor: 'pointer',
        fontSize: '16px',
      }}
      title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}

