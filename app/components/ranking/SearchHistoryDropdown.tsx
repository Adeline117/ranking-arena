'use client'

import React, { useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// ── Icons ──────────────────────────────────────────────────────────────────

const ClockIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CloseSmallIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
    <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
  </svg>
)

// ── Component ──────────────────────────────────────────────────────────────

export interface SearchHistoryDropdownProps {
  history: string[]
  activeIndex: number
  setActiveIndex: (idx: number) => void
  onSelectHistory: (item: string) => void
  onRemoveHistory: (e: React.MouseEvent, item: string) => void
  onClearAll: (e: React.MouseEvent) => void
  dropdownRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Dropdown panel showing recent search history with keyboard navigation support.
 */
export function SearchHistoryDropdown({
  history,
  activeIndex,
  setActiveIndex,
  onSelectHistory,
  onRemoveHistory,
  onClearAll,
  dropdownRef,
}: SearchHistoryDropdownProps) {
  const { t } = useLanguage()

  const handleItemMouseEnter = useCallback((idx: number, e: React.MouseEvent<HTMLDivElement>) => {
    setActiveIndex(idx)
    e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
  }, [setActiveIndex])

  const handleItemMouseLeave = useCallback((idx: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (idx !== activeIndex) {
      e.currentTarget.style.background = 'transparent'
    }
  }, [activeIndex])

  return (
    <div
      ref={dropdownRef}
      role="listbox"
      aria-label={t('searchHistory')}
      aria-live="polite"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.max,
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderTop: 'none',
        borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
        boxShadow: tokens.shadow.lg,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <Box
        role="presentation"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
          <ClockIcon size={11} />
          <Text size="xs" weight="bold" color="tertiary">
            {t('searchHistory')}
          </Text>
        </Box>
        <button
          onClick={onClearAll}
          style={{
            background: 'none',
            border: 'none',
            color: tokens.colors.accent.error,
            cursor: 'pointer',
            fontSize: tokens.typography.fontSize.xs,
            padding: `2px ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            opacity: 0.7,
            transition: `opacity ${tokens.transition.fast}`,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
        >
          {t('clearAll')}
        </button>
      </Box>

      {/* History Items */}
      {history.map((item, idx) => {
        const isActive = idx === activeIndex
        return (
          <div
            key={item}
            id={`search-history-item-${idx}`}
            data-history-item
            role="option"
            aria-selected={isActive}
            onClick={() => onSelectHistory(item)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              cursor: 'pointer',
              background: isActive ? `${tokens.colors.accent.primary}15` : 'transparent',
              borderLeft: isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
              transition: `background ${tokens.transition.fast}, border-color ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => handleItemMouseEnter(idx, e)}
            onMouseLeave={(e) => handleItemMouseLeave(idx, e)}
          >
            <ClockIcon size={11} />
            <Text
              size="sm"
              style={{
                flex: 1,
                color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item}
            </Text>
            <button
              onClick={(e) => onRemoveHistory(e, item)}
              aria-label={t('removeHistoryItem').replace('{item}', item)}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                padding: 4,
                lineHeight: 1.2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.5,
                transition: `opacity ${tokens.transition.fast}, color ${tokens.transition.fast}`,
                flexShrink: 0,
                borderRadius: tokens.radius.sm,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1'
                e.currentTarget.style.color = tokens.colors.accent.error
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.5'
                e.currentTarget.style.color = tokens.colors.text.tertiary
              }}
            >
              <CloseSmallIcon size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
