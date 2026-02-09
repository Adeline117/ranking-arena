'use client'

import { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'

interface TabConfig {
  key: string
  label: string
}

const TABS: TabConfig[] = [
  { key: 'overview', label: '概览' },
  { key: 'movers', label: '涨跌' },
  { key: 'sectors', label: '板块' },
  { key: 'watchlist', label: '自选' },
]

export default function MobileMarketTabs({ children }: {
  children: Record<string, React.ReactNode>
}) {
  const [activeTab, setActiveTab] = useState('overview')
  const containerRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  const currentXRef = useRef(0)
  const isDragging = useRef(false)

  const currentIndex = TABS.findIndex(t => t.key === activeTab)

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

      if (diff > threshold && currentIndex < TABS.length - 1) {
        setActiveTab(TABS[currentIndex + 1].key)
      } else if (diff < -threshold && currentIndex > 0) {
        setActiveTab(TABS[currentIndex - 1].key)
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
        zIndex: 50,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1,
              padding: '10px 0',
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
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div ref={containerRef} style={{ minHeight: '60vh', padding: '12px 0' }}>
        {children[activeTab] || (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 200,
            color: tokens.colors.text.tertiary,
            fontSize: 14,
          }}>
            即将推出
          </div>
        )}
      </div>
    </div>
  )
}
