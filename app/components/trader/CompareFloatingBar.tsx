'use client'

import { memo } from 'react'
import Link from 'next/link'
import { X, BarChart3, ChevronUp, ChevronDown } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'
import { useComparisonStore } from '@/lib/stores'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

/**
 * Floating comparison bar that shows selected traders for comparison
 * Renders at the bottom-right of the screen when traders are selected
 */
function CompareFloatingBar() {
  const { t } = useLanguage()
  const {
    selectedTraders,
    isBarExpanded,
    removeTrader,
    clearAll,
    toggleBar,
    getCompareUrl,
  } = useComparisonStore()

  // Don't render if no traders selected
  if (selectedTraders.length === 0) {
    return null
  }

  const compareUrl = getCompareUrl()

  return (
    <div
      className="compare-floating-bar"
      style={{
        position: 'fixed',
        bottom: 80, // Above mobile nav
        right: 16,
        zIndex: tokens.zIndex.overlay,
        background: tokens.glass.bg.heavy,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        border: tokens.glass.border.medium,
        borderRadius: tokens.radius.xl,
        boxShadow: tokens.shadow.xl,
        overflow: 'hidden',
        transition: `all ${tokens.transition.slow}`,
        maxWidth: isBarExpanded ? 'min(320px, calc(100vw - 32px))' : 56,
        width: isBarExpanded ? 'min(320px, calc(100vw - 32px))' : 56,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isBarExpanded ? '12px 14px' : '12px',
          borderBottom: isBarExpanded ? tokens.glass.border.light : 'none',
          cursor: 'pointer',
        }}
        onClick={toggleBar}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={20} color={tokens.colors.accent.primary} />
          {isBarExpanded && (
            <>
              <span style={{
                fontSize: 14,
                fontWeight: 700,
                color: tokens.colors.text.primary,
              }}>
                {t('compare') || 'Compare'}
              </span>
              <span style={{
                padding: '2px 6px',
                borderRadius: tokens.radius.sm,
                background: tokens.colors.accent.primary,
                color: tokens.colors.white,
                fontSize: 11,
                fontWeight: 700,
              }}>
                {selectedTraders.length}/5
              </span>
            </>
          )}
        </div>

        {isBarExpanded ? (
          <ChevronDown size={18} color={tokens.colors.text.secondary} />
        ) : (
          <ChevronUp size={18} color={tokens.colors.text.secondary} />
        )}
      </div>

      {/* Expanded content */}
      {isBarExpanded && (
        <>
          {/* Trader list */}
          <div style={{
            padding: '8px 12px',
            maxHeight: 200,
            overflowY: 'auto',
          }}>
            {selectedTraders.map((trader) => (
              <div
                key={trader.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                  {/* Avatar placeholder */}
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: tokens.radius.md,
                    background: tokens.gradient.primarySubtle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    color: tokens.colors.accent.primary,
                    flexShrink: 0,
                  }}>
                    {trader.handle?.[0]?.toUpperCase() || 'T'}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: tokens.colors.text.primary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {trader.handle}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: tokens.colors.text.tertiary,
                    }}>
                      {EXCHANGE_NAMES[trader.source] || trader.source}
                    </div>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTrader(trader.id)
                  }}
                  className="btn-press"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: tokens.radius.sm,
                    border: 'none',
                    background: 'transparent',
                    color: tokens.colors.text.tertiary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{
            padding: '10px 12px',
            display: 'flex',
            gap: 8,
            borderTop: tokens.glass.border.light,
          }}>
            <button
              onClick={clearAll}
              className="btn-press"
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: tokens.radius.md,
                border: tokens.glass.border.light,
                background: 'transparent',
                color: tokens.colors.text.secondary,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('clearAll') || 'Clear'}
            </button>

            <Link
              href={compareUrl}
              className="btn-press"
              style={{
                flex: 2,
                padding: '8px 12px',
                borderRadius: tokens.radius.md,
                border: 'none',
                background: tokens.gradient.primary,
                color: tokens.colors.white,
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                textDecoration: 'none',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <BarChart3 size={14} />
              {t('viewComparison') || 'View Comparison'}
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

export default memo(CompareFloatingBar)
