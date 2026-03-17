'use client'

import { useCallback, useRef, useEffect } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
  activeAccount: string // 'all' or platform key
  onAccountChange: (account: string) => void
}

export default function LinkedAccountTabs({
  accounts,
  activeAccount,
  onAccountChange,
}: LinkedAccountTabsProps) {
  const { t, language } = useLanguage()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll active tab into view on mount
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const activeEl = container.querySelector('[data-active="true"]') as HTMLElement | null
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }, [activeAccount])

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
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

  return (
    <Box
      ref={scrollRef}
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
          style={{
            color: activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          }}
        >
          {language === 'zh' ? '综合' : 'All'}
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

      {/* Per-exchange tabs */}
      {accounts.map((account) => {
        const key = `${account.platform}:${account.traderKey}`
        const isActive = activeAccount === key
        const displayLabel = account.label || EXCHANGE_NAMES[account.platform] || account.platform

        return (
          <button
            key={key}
            style={tabStyle(isActive)}
            onClick={() => onAccountChange(key)}
            data-active={isActive}
          >
            <ExchangeLogo exchange={account.platform} size={16} />
            <Text
              size="sm"
              weight={isActive ? 'bold' : 'medium'}
              style={{
                color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary,
              }}
            >
              {displayLabel}
            </Text>
          </button>
        )
      })}

      <style>{`
        .linked-tabs-scroll::-webkit-scrollbar { display: none; }
      `}</style>
    </Box>
  )
}
