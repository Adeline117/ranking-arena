'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { preload } from 'swr'
import { tokens } from '@/lib/design-tokens'
import { formatROI } from '@/lib/utils/format'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { traderFetcher } from '@/lib/hooks/traderFetcher'

export interface LinkedAccount {
  id: string
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  isPrimary: boolean
  roi: number | null
  pnl: number | null
  arenaScore: number | null
}

interface LinkedAccountTabsProps {
  accounts: LinkedAccount[]
  activeAccount: string // 'all' or platform:traderKey
  onAccountChange: (account: string) => void
}


export default function LinkedAccountTabs({
  accounts,
  activeAccount,
  onAccountChange,
}: LinkedAccountTabsProps) {
  const { t } = useLanguage()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isMobileDropdown, setIsMobileDropdown] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Detect mobile for dropdown mode (4+ accounts)
  useEffect(() => {
    if (accounts.length < 4) {
      setIsMobileDropdown(false)
      return
    }
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobileDropdown(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobileDropdown(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [accounts.length])

  // Scroll active tab into view on mount
  useEffect(() => {
    const container = scrollRef.current
    if (!container || isMobileDropdown) return
    const activeEl = container.querySelector('[data-active="true"]') as HTMLElement | null
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }, [activeAccount, isMobileDropdown])

  // Prefetch trader data on tab hover (desktop) for instant account switching
  const prefetchAccount = useCallback((account: LinkedAccount) => {
    const handle = account.handle || account.traderKey
    const url = `/api/traders/${encodeURIComponent(handle)}?source=${encodeURIComponent(account.platform)}`
    preload(url, traderFetcher)
  }, [])

  // #32: Close dropdown on outside mousedown (faster than click)
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = () => setDropdownOpen(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  // #27: Arrow key navigation between tabs (WAI-ARIA tabs pattern)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const keys = ['all', ...accounts.map(a => `${a.platform}:${a.traderKey}`)]
    const idx = keys.indexOf(activeAccount)
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = idx < keys.length - 1 ? idx + 1 : 0
      onAccountChange(keys[next])
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = idx > 0 ? idx - 1 : keys.length - 1
      onAccountChange(keys[prev])
    }
  }, [accounts, activeAccount, onAccountChange])

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 14px',
    minHeight: 44,
    borderRadius: tokens.radius.md,
    border: `1px solid ${isActive ? tokens.colors.accent.primary + '60' : tokens.colors.border.primary}`,
    background: isActive
      ? `${tokens.colors.accent.primary}15`
      : tokens.colors.bg.secondary,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  })

  // Find active account info for dropdown trigger
  const getActiveLabel = () => {
    if (activeAccount === 'all') return t('linkedAccountAll')
    const acc = accounts.find(a => `${a.platform}:${a.traderKey}` === activeAccount)
    if (!acc) return t('linkedAccountAll')
    return acc.label || EXCHANGE_NAMES[acc.platform] || acc.platform
  }

  // Mobile dropdown mode
  if (isMobileDropdown) {
    return (
      <Box style={{ position: 'relative', marginBottom: tokens.spacing[4] }}>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            cursor: 'pointer',
            width: '100%',
            justifyContent: 'space-between',
          }}
          onClick={(e) => { e.stopPropagation(); setDropdownOpen(!dropdownOpen) }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {activeAccount !== 'all' && (() => {
              const acc = accounts.find(a => `${a.platform}:${a.traderKey}` === activeAccount)
              return acc ? <ExchangeLogo exchange={acc.platform} size={18} /> : null
            })()}
            <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
              {getActiveLabel()}
            </Text>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary, background: `${tokens.colors.text.tertiary}15`, padding: '1px 6px', borderRadius: 10, fontSize: 10 }}>
              {accounts.length}
            </Text>
          </Box>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: dropdownOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {dropdownOpen && (
          <Box
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 4,
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              boxShadow: '0 8px 24px var(--color-overlay-medium)',
              zIndex: 50,
              overflow: 'hidden',
            }}
          >
            {/* All option */}
            <button
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', width: '100%',
                background: activeAccount === 'all' ? `${tokens.colors.accent.primary}10` : 'transparent',
                border: 'none', cursor: 'pointer',
              }}
              onClick={() => { onAccountChange('all'); setDropdownOpen(false) }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
              <Text size="sm" weight={activeAccount === 'all' ? 'bold' : 'medium'} style={{ color: activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.secondary, flex: 1, textAlign: 'left' }}>
                {t('linkedAccountAll')}
              </Text>
            </button>

            {accounts.map(account => {
              const key = `${account.platform}:${account.traderKey}`
              const isActive = activeAccount === key
              const label = account.label || EXCHANGE_NAMES[account.platform] || account.platform

              return (
                <button
                  key={key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', width: '100%',
                    background: isActive ? `${tokens.colors.accent.primary}10` : 'transparent',
                    border: 'none', cursor: 'pointer',
                    borderTop: `1px solid ${tokens.colors.border.primary}40`,
                  }}
                  onClick={() => { onAccountChange(key); setDropdownOpen(false) }}
                >
                  <ExchangeLogo exchange={account.platform} size={18} />
                  <Text size="sm" weight={isActive ? 'bold' : 'medium'} style={{ color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary, flex: 1, textAlign: 'left' }}>
                    {label}
                  </Text>
                  {account.isPrimary && (
                    <Text size="xs" style={{ color: tokens.colors.accent.warning, fontSize: 10 }}>★</Text>
                  )}
                  {account.roi != null && (
                    <Text size="xs" weight="bold" style={{
                      color: account.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                      fontFamily: tokens.typography.fontFamily.mono.join(', '),
                      fontSize: 11,
                    }}>
                      {formatROI(account.roi)}
                    </Text>
                  )}
                </button>
              )
            })}
          </Box>
        )}
      </Box>
    )
  }

  // Desktop: horizontal scroll tabs
  return (
    <Box
      ref={scrollRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        gap: 8,
        overflowX: 'auto',
        paddingBottom: 4,
        marginBottom: tokens.spacing[4],
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
      className="linked-tabs-scroll"
    >
      {/* All tab */}
      <button
        role="tab"
        tabIndex={activeAccount === 'all' ? 0 : -1}
        aria-selected={activeAccount === 'all'}
        style={tabStyle(activeAccount === 'all')}
        onClick={() => onAccountChange('all')}
        data-active={activeAccount === 'all'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
        <Text
          size="sm"
          weight={activeAccount === 'all' ? 'bold' : 'medium'}
          style={{ color: activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.secondary }}
        >
          {t('linkedAccountAll')}
        </Text>
        <Text
          size="xs"
          style={{
            color: tokens.colors.text.tertiary,
            fontSize: 10,
            background: `${tokens.colors.text.tertiary}15`,
            padding: '1px 6px',
            borderRadius: 10,
          }}
        >
          {accounts.length}
        </Text>
      </button>

      {/* Per-exchange tabs with ROI + primary indicator */}
      {accounts.map((account) => {
        const key = `${account.platform}:${account.traderKey}`
        const isActive = activeAccount === key
        const displayLabel = account.label || EXCHANGE_NAMES[account.platform] || account.platform

        return (
          <button
            key={key}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            style={tabStyle(isActive)}
            onClick={() => onAccountChange(key)}
            onMouseEnter={() => prefetchAccount(account)}
            data-active={isActive}
          >
            <ExchangeLogo exchange={account.platform} size={16} />
            <Text
              size="sm"
              weight={isActive ? 'bold' : 'medium'}
              style={{ color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary }}
            >
              {displayLabel}
            </Text>
            {account.isPrimary && (
              <Text size="xs" style={{ color: tokens.colors.accent.warning, fontSize: 11, lineHeight: 1 }} title={t('traderPrimaryAccount')}>★</Text>
            )}
            {account.roi != null && (
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: account.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  fontSize: 11,
                  letterSpacing: '-0.02em',
                }}
              >
                {formatROI(account.roi)}
              </Text>
            )}
          </button>
        )
      })}

      <style>{`
        .linked-tabs-scroll::-webkit-scrollbar { display: none; }
      `}</style>
    </Box>
  )
}
