'use client'

import { useRef, useEffect, useState, useCallback, useId } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { formatROI } from '@/lib/utils/format'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { linkedAccountDisplayLabel } from './linked-account-view'

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

function trustedLinkedRoi(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= -10_000 && value <= 10_000
    ? value
    : null
}

export default function LinkedAccountTabs({
  accounts,
  activeAccount,
  onAccountChange,
}: LinkedAccountTabsProps) {
  const { t } = useLanguage()
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null)
  const dropdownOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [isMobileDropdown, setIsMobileDropdown] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownId = useId()

  const closeDropdown = useCallback((restoreFocus = false) => {
    setDropdownOpen(false)
    if (restoreFocus) requestAnimationFrame(() => dropdownTriggerRef.current?.focus())
  }, [])

  const focusDropdownOption = useCallback((index: number) => {
    const options = dropdownOptionRefs.current.filter(
      (option): option is HTMLButtonElement => option !== null
    )
    if (options.length === 0) return
    const normalized = (index + options.length) % options.length
    options[normalized]?.focus()
  }, [])

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

  // Probe the same exact first-screen boundary used by the selection state
  // machine. Mixed serving/legacy relations cannot inherit the route account's
  // data mode; legacy accounts naturally 404 here and fall back after click.
  const prefetchAccount = useCallback(
    (account: LinkedAccount) => {
      const url = `/api/traders/${encodeURIComponent(account.traderKey)}/first-screen?source=${encodeURIComponent(account.platform)}`
      queryClient.prefetchQuery({
        queryKey: ['linked-trader-first-screen', account.platform, account.traderKey],
        queryFn: () => traderFetcher(url),
        staleTime: 0,
      })
    },
    [queryClient]
  )

  // #32: Close dropdown on outside mousedown (faster than click)
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (event: MouseEvent) => {
      if (scrollRef.current?.contains(event.target as Node)) return
      setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  useEffect(() => {
    if (!dropdownOpen || !isMobileDropdown) return
    const keys = ['all', ...accounts.map((account) => `${account.platform}:${account.traderKey}`)]
    const activeIndex = Math.max(0, keys.indexOf(activeAccount))
    requestAnimationFrame(() => focusDropdownOption(activeIndex))
  }, [accounts, activeAccount, dropdownOpen, focusDropdownOption, isMobileDropdown])

  // Arrow-key navigation for the desktop single-select radio group.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const keys = ['all', ...accounts.map((a) => `${a.platform}:${a.traderKey}`)]
      const idx = keys.indexOf(activeAccount)
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = idx < keys.length - 1 ? idx + 1 : 0
        onAccountChange(keys[next])
        requestAnimationFrame(() => {
          const tabs = scrollRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []
          Array.from(tabs)
            .find((tab) => tab.dataset.accountKey === keys[next])
            ?.focus()
        })
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = idx > 0 ? idx - 1 : keys.length - 1
        onAccountChange(keys[prev])
        requestAnimationFrame(() => {
          const tabs = scrollRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []
          Array.from(tabs)
            .find((tab) => tab.dataset.accountKey === keys[prev])
            ?.focus()
        })
      }
    },
    [accounts, activeAccount, onAccountChange]
  )

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 14px',
    minHeight: 44,
    borderRadius: tokens.radius.md,
    border: `1px solid ${isActive ? colorAlpha(tokens.colors.accent.primary, 38) : tokens.colors.border.primary}`,
    background: isActive ? `${alpha(tokens.colors.accent.primary, 8)}` : tokens.colors.bg.secondary,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  })

  // Find active account info for dropdown trigger
  const getActiveLabel = () => {
    if (activeAccount === 'all') return t('linkedAccountAll')
    const acc = accounts.find((a) => `${a.platform}:${a.traderKey}` === activeAccount)
    if (!acc) return t('linkedAccountAll')
    return linkedAccountDisplayLabel(acc, accounts)
  }

  // Mobile dropdown mode
  if (isMobileDropdown) {
    return (
      <Box
        ref={scrollRef}
        data-testid="linked-account-selector"
        style={{ position: 'relative', marginBottom: tokens.spacing[4] }}
      >
        <button
          type="button"
          ref={dropdownTriggerRef}
          aria-expanded={dropdownOpen}
          aria-controls={dropdownId}
          aria-haspopup="menu"
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
          onClick={(e) => {
            e.stopPropagation()
            setDropdownOpen((open) => !open)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setDropdownOpen(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              closeDropdown(true)
            }
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {activeAccount !== 'all' &&
              (() => {
                const acc = accounts.find((a) => `${a.platform}:${a.traderKey}` === activeAccount)
                return acc ? <ExchangeLogo exchange={acc.platform} size={18} /> : null
              })()}
            <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
              {getActiveLabel()}
            </Text>
            <Text
              size="xs"
              style={{
                color: tokens.colors.text.tertiary,
                background: `${alpha(tokens.colors.text.tertiary, 8)}`,
                padding: '1px 6px',
                borderRadius: 10,
                fontSize: 10,
              }}
            >
              {accounts.length}
            </Text>
          </Box>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.text.tertiary}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: dropdownOpen ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.2s',
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {dropdownOpen && (
          <Box
            id={dropdownId}
            role="menu"
            aria-label={t('linkedAccounts')}
            onKeyDown={(event: React.KeyboardEvent) => {
              const options = dropdownOptionRefs.current.filter(
                (option): option is HTMLButtonElement => option !== null
              )
              const currentIndex = options.findIndex((option) => option === document.activeElement)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusDropdownOption(currentIndex + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusDropdownOption(currentIndex - 1)
              } else if (event.key === 'Home') {
                event.preventDefault()
                focusDropdownOption(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                focusDropdownOption(options.length - 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeDropdown(true)
              } else if (event.key === 'Tab') {
                closeDropdown(false)
              }
            }}
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
              type="button"
              role="menuitemradio"
              ref={(element) => {
                dropdownOptionRefs.current[0] = element
              }}
              tabIndex={-1}
              aria-checked={activeAccount === 'all'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                width: '100%',
                background:
                  activeAccount === 'all'
                    ? `${alpha(tokens.colors.accent.primary, 6)}`
                    : 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onClick={() => {
                onAccountChange('all')
                closeDropdown(true)
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={
                  activeAccount === 'all'
                    ? tokens.colors.accent.primary
                    : tokens.colors.text.tertiary
                }
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              <Text
                size="sm"
                weight={activeAccount === 'all' ? 'bold' : 'medium'}
                style={{
                  color:
                    activeAccount === 'all'
                      ? tokens.colors.accent.primary
                      : tokens.colors.text.secondary,
                  flex: 1,
                  textAlign: 'left',
                }}
              >
                {t('linkedAccountAll')}
              </Text>
            </button>

            {accounts.map((account, index) => {
              const key = `${account.platform}:${account.traderKey}`
              const isActive = activeAccount === key
              const label = linkedAccountDisplayLabel(account, accounts)
              const roi = trustedLinkedRoi(account.roi)

              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  ref={(element) => {
                    dropdownOptionRefs.current[index + 1] = element
                  }}
                  tabIndex={-1}
                  aria-checked={isActive}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 16px',
                    width: '100%',
                    background: isActive
                      ? `${alpha(tokens.colors.accent.primary, 6)}`
                      : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderTop: `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
                  }}
                  onClick={() => {
                    onAccountChange(key)
                    closeDropdown(true)
                  }}
                  onMouseEnter={() => prefetchAccount(account)}
                >
                  <ExchangeLogo exchange={account.platform} size={18} />
                  <Text
                    size="sm"
                    weight={isActive ? 'bold' : 'medium'}
                    style={{
                      color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                      flex: 1,
                      textAlign: 'left',
                    }}
                  >
                    {label}
                  </Text>
                  {account.isPrimary && (
                    <Text
                      size="xs"
                      aria-label={t('traderPrimaryAccount')}
                      style={{ color: tokens.colors.accent.warning, fontSize: 10 }}
                    >
                      <span aria-hidden="true">★</span>
                    </Text>
                  )}
                  {roi != null && (
                    <Text
                      size="xs"
                      weight="bold"
                      title={t('traderAccountMetricsPartial')}
                      style={{
                        color: roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        fontSize: 11,
                      }}
                    >
                      {formatROI(roi)} · 90D · {t('dataPartial')}
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

  // Desktop: horizontal, single-select account radio group.
  return (
    <Box
      ref={scrollRef}
      role="radiogroup"
      aria-label={t('linkedAccounts')}
      data-testid="linked-account-selector"
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
        type="button"
        role="radio"
        tabIndex={activeAccount === 'all' ? 0 : -1}
        aria-checked={activeAccount === 'all'}
        style={tabStyle(activeAccount === 'all')}
        onClick={() => onAccountChange('all')}
        data-active={activeAccount === 'all'}
        data-account-key="all"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={
            activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.tertiary
          }
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
        <Text
          size="sm"
          weight={activeAccount === 'all' ? 'bold' : 'medium'}
          style={{
            color:
              activeAccount === 'all' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          }}
        >
          {t('linkedAccountAll')}
        </Text>
        <Text
          size="xs"
          style={{
            color: tokens.colors.text.tertiary,
            fontSize: 10,
            background: `${alpha(tokens.colors.text.tertiary, 8)}`,
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
        const displayLabel = linkedAccountDisplayLabel(account, accounts)
        const roi = trustedLinkedRoi(account.roi)

        return (
          <button
            key={key}
            type="button"
            role="radio"
            tabIndex={isActive ? 0 : -1}
            aria-checked={isActive}
            style={tabStyle(isActive)}
            onClick={() => onAccountChange(key)}
            onMouseEnter={() => prefetchAccount(account)}
            data-active={isActive}
            data-account-key={key}
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
            {account.isPrimary && (
              <Text
                size="xs"
                aria-label={t('traderPrimaryAccount')}
                style={{ color: tokens.colors.accent.warning, fontSize: 11, lineHeight: 1 }}
                title={t('traderPrimaryAccount')}
              >
                <span aria-hidden="true">★</span>
              </Text>
            )}
            {roi != null && (
              <Text
                size="xs"
                weight="bold"
                title={t('traderAccountMetricsPartial')}
                style={{
                  color: roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  fontSize: 11,
                  letterSpacing: '-0.02em',
                }}
              >
                {formatROI(roi)} · 90D · {t('dataPartial')}
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
