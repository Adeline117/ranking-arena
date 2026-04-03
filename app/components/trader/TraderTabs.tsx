'use client'

import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'

export type TabKey = 'overview' | 'stats' | 'portfolio' | 'posts'

interface TraderTabsProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  isPro?: boolean
  onProRequired?: () => void
  /** Extra tab keys to show beyond the default 3 */
  extraTabs?: TabKey[]
  /** Tab keys to hide from the default set */
  hideTabs?: TabKey[]
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export default function TraderTabs({ activeTab, onTabChange, isPro = false, onProRequired: _onProRequired, extraTabs, hideTabs }: TraderTabsProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<TabKey, HTMLButtonElement>>(new Map())
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })
  const [scrollState, setScrollState] = useState({ canScrollLeft: false, canScrollRight: false })

  const updateScrollState = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setScrollState({
      canScrollLeft: el.scrollLeft > 2,
      canScrollRight: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  const hideSet = hideTabs ? new Set(hideTabs) : null
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: t('overview') },
    { key: 'stats', label: t('stats') },
    ...(!hideSet?.has('portfolio') ? [{ key: 'portfolio' as TabKey, label: t('portfolio') }] : []),
    ...(extraTabs?.includes('posts') ? [{ key: 'posts' as TabKey, label: t('posts') }] : []),
  ]

  const updateIndicator = useCallback(() => {
    const el = tabRefs.current.get(activeTab)
    const container = containerRef.current
    if (!el || !container) return
    const containerRect = container.getBoundingClientRect()
    const tabRect = el.getBoundingClientRect()
    setIndicator({
      left: tabRect.left - containerRect.left + container.scrollLeft,
      width: tabRect.width,
    })
  }, [activeTab])

  useIsomorphicLayoutEffect(() => {
    updateIndicator()
  }, [updateIndicator])

  // Update on resize
  useEffect(() => {
    window.addEventListener('resize', updateIndicator)
    return () => window.removeEventListener('resize', updateIndicator)
  }, [updateIndicator])

  // Update scroll indicators
  useEffect(() => {
    updateScrollState()
    const el = containerRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState, { passive: true })
    window.addEventListener('resize', updateScrollState)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      window.removeEventListener('resize', updateScrollState)
    }
  }, [updateScrollState])

  return (
    <div style={{ position: 'relative', marginBottom: tokens.spacing[5] }}>
      {/* Left scroll fade indicator */}
      {scrollState.canScrollLeft && (
        <div aria-hidden="true" style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 32, zIndex: 2,
          background: 'linear-gradient(to right, var(--color-bg-primary), transparent)',
          pointerEvents: 'none',
        }} />
      )}
      {/* Right scroll fade indicator */}
      {scrollState.canScrollRight && (
        <div aria-hidden="true" style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 32, zIndex: 2,
          background: 'linear-gradient(to left, var(--color-bg-primary), transparent)',
          pointerEvents: 'none',
        }} />
      )}
      <Box
        ref={containerRef}
        className="profile-tabs"
        role="tablist"
        aria-label={t('traderProfileTabs')}
        style={{
          display: 'flex',
          gap: tokens.spacing[1],
          position: 'relative',
          padding: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
          paddingBottom: tokens.spacing[2],
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          borderBottom: `1px solid ${tokens.colors.border.primary}40`,
        }}
      >
        {/* Sliding indicator */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: indicator.left,
            width: indicator.width,
            height: 3,
            background: `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
            borderRadius: 1.5,
            transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: `0 0 6px var(--color-accent-primary-30, ${tokens.colors.accent.primary}30)`,
            zIndex: 1,
          }}
        />

        {tabs.map((tab) => {
          const isProTab = tab.key === 'stats' || tab.key === 'portfolio'
          const showProBadge = !isPro && isProTab
          return (
            <button
              key={tab.key}
              ref={(el) => { if (el) tabRefs.current.set(tab.key, el) }}
              className="profile-tab-button interactive-scale"
              onClick={() => onTabChange(tab.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onTabChange(tab.key)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  const currentIndex = tabs.findIndex((t) => t.key === activeTab)
                  const direction = e.key === 'ArrowLeft' ? -1 : 1
                  const newIndex = (currentIndex + direction + tabs.length) % tabs.length
                  onTabChange(tabs[newIndex].key)
                }
              }}
              aria-label={tab.label}
              aria-selected={activeTab === tab.key}
              role="tab"
              tabIndex={activeTab === tab.key ? 0 : -1}
              style={{
                background: activeTab === tab.key
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}15, ${tokens.colors.accent.primary}08)`
                  : 'transparent',
                border: activeTab === tab.key
                  ? `1px solid ${tokens.colors.accent.primary}30`
                  : '1px solid transparent',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                minHeight: 44,
                cursor: 'pointer',
                position: 'relative',
                borderRadius: tokens.radius.lg,
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
              }}
              onMouseEnter={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = `${tokens.colors.bg.tertiary}80`
                  e.currentTarget.style.transform = 'translateY(-2px)'
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.transform = 'translateY(0)'
                }
              }}
            >
              <Text
                size="sm"
                weight={activeTab === tab.key ? 'black' : 'medium'}
                style={{
                  color: activeTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.secondary,
                  transition: 'color 0.3s ease',
                }}
              >
                {tab.label}
              </Text>
              {showProBadge && (
                <Box style={{
                  padding: '1px 6px',
                  borderRadius: tokens.radius.sm,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.primary}25, ${tokens.colors.accent.brand}15)`,
                  border: `1px solid ${tokens.colors.accent.primary}30`,
                }}>
                  <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontSize: 9 }}>
                    PRO
                  </Text>
                </Box>
              )}
            </button>
          )
        })}
      </Box>
    </div>
  )
}
