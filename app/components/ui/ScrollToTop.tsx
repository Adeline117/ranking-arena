'use client'

import { useState, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function ScrollToTop() {
  const [visible, setVisible] = useState(false)
  const { t } = useLanguage()
  const pathname = usePathname()

  // Pages where FAB is shown — keep scroll-to-top from overlapping
  const fabPages = ['/', '/groups']
  const hasFab = fabPages.some(p => pathname === p || pathname.startsWith('/groups/'))

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > 500)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <button
      onClick={scrollToTop}
      aria-label={t('scrollToTop')}
      className="scroll-to-top-btn"
      style={{
        position: 'fixed',
        bottom: hasFab ? 'calc(var(--mobile-nav-height, 60px) + 80px)' : 'calc(var(--mobile-nav-height, 60px) + 16px)',
        right: 16,
        zIndex: 50,
        width: 44,
        height: 44,
        borderRadius: '50%',
        border: '1px solid var(--color-border-secondary, rgba(255,255,255,0.1))',
        background: 'var(--color-bg-secondary, #14121C)',
        color: 'var(--color-text-secondary, #A8A8B3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'var(--shadow-sm-dark)',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease, background 0.2s ease, border-color 0.2s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-brand, #8b6fa8)'
        e.currentTarget.style.color = 'var(--color-brand, #8b6fa8)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-secondary, rgba(255,255,255,0.1))'
        e.currentTarget.style.color = 'var(--color-text-secondary, #A8A8B3)'
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>
  )
}
