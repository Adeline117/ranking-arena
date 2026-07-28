'use client'

import { memo, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X, BarChart3, ChevronUp, ChevronDown } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import { useShallow } from 'zustand/react/shallow'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { buildCompareUrl, compareAccountKey } from '@/lib/compare/identity'
import { isFloatingActionRoute } from '@/lib/features'

/**
 * Floating comparison bar that shows selected traders for comparison
 * Renders at the bottom-right of the screen when traders are selected
 */
function CompareFloatingBar() {
  const { t } = useLanguage()
  const pathname = usePathname()
  const hasFab = isFloatingActionRoute(pathname)
  const persistentStackOffset = hasFab ? 208 : 128
  const bottomPosition = `calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px) + var(--transient-bottom-offset, 0px) + var(--page-bottom-overlay-offset, 0px) + ${persistentStackOffset}px)`
  const expandedMaxHeight = `calc(100dvh - var(--safe-area-inset-top, 0px) - var(--mobile-nav-height, 60px) - var(--safe-area-inset-bottom, 0px) - var(--transient-bottom-offset, 0px) - var(--page-bottom-overlay-offset, 0px) - ${persistentStackOffset}px - 8px)`
  const { selectedTraders, isBarExpanded, removeTrader, clearAll, toggleBar } = useComparisonStore(
    useShallow((s) => ({
      selectedTraders: s.selectedTraders,
      isBarExpanded: s.isBarExpanded,
      removeTrader: s.removeTrader,
      clearAll: s.clearAll,
      toggleBar: s.toggleBar,
    }))
  )

  // Derive the URL directly from the SUBSCRIBED selectedTraders — NOT from a
  // getCompareUrl() snapshot. The snapshot froze the <Link> href at the value
  // present when the anchor first mounted (adding/removing traders updated the
  // list + count but left href pointing at the stale selection). Keying the
  // Link on the derived URL forces a fresh href attribute on every change.
  const compareUrl = useMemo(() => buildCompareUrl(selectedTraders), [selectedTraders])

  // Don't render if no traders selected
  if (selectedTraders.length === 0) {
    return null
  }

  return (
    <div
      className="compare-floating-bar"
      style={{
        position: 'fixed',
        // Own the slot above the active persistent bottom-right stack. FAB routes
        // need 208px to clear FAB + ScrollToTop + Feedback; ordinary routes need
        // 128px to clear ScrollToTop + Feedback. Both retain a real 12px gap.
        // Page-owned and transient bottom overlays are measured at runtime; snap
        // to their new total immediately so this bar never animates through them.
        bottom: bottomPosition,
        right: 16,
        zIndex: tokens.zIndex.overlay,
        background: tokens.glass.bg.heavy,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        border: tokens.glass.border.medium,
        borderRadius: tokens.radius.xl,
        boxShadow: tokens.shadow.xl,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        transition: `width ${tokens.transition.slow}, max-width ${tokens.transition.slow}`,
        maxHeight: isBarExpanded ? expandedMaxHeight : 56,
        maxWidth: isBarExpanded ? 'min(320px, calc(100vw - 32px))' : 56,
        width: isBarExpanded ? 'min(320px, calc(100vw - 32px))' : 56,
      }}
    >
      {/* Header */}
      <button
        type="button"
        className="compare-floating-toggle"
        aria-expanded={isBarExpanded}
        aria-label={isBarExpanded ? `${t('collapse')} ${t('compare')}` : t('compare')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isBarExpanded ? '12px 14px' : '12px',
          borderBottom: isBarExpanded ? tokens.glass.border.light : 'none',
          borderTop: 'none',
          borderRight: 'none',
          borderLeft: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          width: '100%',
          minHeight: 44,
          flexShrink: 0,
          cursor: 'pointer',
        }}
        onClick={toggleBar}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={20} color={tokens.colors.accent.primary} />
          {isBarExpanded && (
            <>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: tokens.colors.text.primary,
                }}
              >
                {t('compare')}
              </span>
              <span
                style={{
                  padding: '2px 6px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {selectedTraders.length}/10
              </span>
            </>
          )}
        </div>

        {isBarExpanded ? (
          <ChevronDown size={18} color={tokens.colors.text.secondary} />
        ) : (
          <ChevronUp size={18} color={tokens.colors.text.secondary} />
        )}
      </button>

      {/* Expanded content */}
      {isBarExpanded && (
        <>
          {/* Trader list */}
          <div
            className="compare-trader-list"
            style={{
              padding: '8px 12px',
              maxHeight: 200,
              minHeight: 0,
              flex: '1 1 200px',
              overflowY: 'auto',
            }}
          >
            {selectedTraders.map((trader) => (
              <div
                key={compareAccountKey(trader)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}
                >
                  {/* Avatar placeholder */}
                  <div
                    style={{
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
                    }}
                  >
                    {trader.handle?.[0]?.toUpperCase() || 'T'}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: tokens.colors.text.primary,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {trader.handle}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: tokens.colors.text.tertiary,
                      }}
                    >
                      {EXCHANGE_NAMES[trader.source] || trader.source}
                    </div>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTrader(trader)
                  }}
                  aria-label={`${t('removeFromCompare')}: ${trader.handle}`}
                  title={`${t('removeFromCompare')}: ${trader.handle}`}
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
          <div
            style={{
              padding: '10px 12px',
              display: 'flex',
              gap: 8,
              borderTop: tokens.glass.border.light,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={clearAll}
              className="btn-press compare-clear-button"
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
              {t('clearAll')}
            </button>

            <Link
              key={compareUrl}
              href={compareUrl}
              className="btn-press compare-view-link"
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
              {t('viewComparison')}
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

export default memo(CompareFloatingBar)
