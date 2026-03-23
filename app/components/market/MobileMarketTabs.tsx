'use client'

import { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TAB_KEYS = [
  { key: 'overview', i18nKey: 'mobileMarketOverview' as const },
  { key: 'movers', i18nKey: 'mobileMarketMovers' as const },
  { key: 'sectors', i18nKey: 'mobileMarketSectors' as const },
  { key: 'watchlist', i18nKey: 'mobileMarketWatchlist' as const },
]

export default function MobileMarketTabs({ children }: {
  children: Record<string, React.ReactNode>
}) {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState('overview')
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(new Set(['overview']))
  const containerRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  const currentXRef = useRef(0)
  const isDragging = useRef(false)

  const currentIndex = TAB_KEYS.findIndex(tab => tab.key === activeTab)

  // Track mounted tabs for caching
  useEffect(() => {
    setMountedTabs(prev => {
      if (prev.has(activeTab)) return prev
      return new Set([...prev, activeTab])
    })
  }, [activeTab])

  // Swipe handling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      startXRef.current = e.touches[0].clientX
      isDragging.current = true
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return
      currentXRef.current = e.touches[0].clientX
    }
    const onTouchEnd = () => {
      if (!isDragging.current) return
      isDragging.current = false
      const diff = startXRef.current - currentXRef.current
      const threshold = 60

      if (diff > threshold && currentIndex < TAB_KEYS.length - 1) {
        setActiveTab(TAB_KEYS[currentIndex + 1].key)
      } else if (diff < -threshold && currentIndex > 0) {
        setActiveTab(TAB_KEYS[currentIndex - 1].key)
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [currentIndex])

  return (
    <div>
      {/* Tab Bar */}
      <div style={{
        display: 'flex',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
        position: 'sticky',
        top: 48, // below SentimentBar
        zIndex: tokens.zIndex.dropdown,
      }}>
        {TAB_KEYS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1,
              padding: '12px 0',
              minHeight: 44,
              fontSize: 13,
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.key ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {t(tab.i18nKey)}
          </button>
        ))}
      </div>

      {/* Tab Content - cached: once mounted, keep in DOM but hide */}
      <div ref={containerRef} style={{ minHeight: '60vh', padding: '16px 0' }}>
        {TAB_KEYS.map(tab => {
          if (!mountedTabs.has(tab.key)) return null
          const isActive = tab.key === activeTab
          return (
            <div
              key={tab.key}
              style={{ display: isActive ? 'block' : 'none' }}
            >
              {children[tab.key] || (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 200,
                  color: tokens.colors.text.tertiary,
                  fontSize: 14,
                }}>
                  {t('comingSoon')}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
