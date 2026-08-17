'use client'

import { useRef } from 'react'
// CSS animations replace framer-motion (~40KB bundle savings)
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface TokenInfo {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change24h: number
  marketCap: number
  volume24h: number
  high24h: number
  low24h: number
  rank: number
}

function formatNum(n: number | null | undefined): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

function formatPrice(n: number): string {
  if (n >= 1)
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '7px 0',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: tokens.typography.fontSize.sm,
      }}
    >
      <span style={{ color: tokens.colors.text.tertiary }}>{label}</span>
      <span
        style={{
          color: tokens.colors.text.primary,
          fontWeight: tokens.typography.fontWeight.medium,
        }}
      >
        {value}
      </span>
    </div>
  )
}

export default function TokenSidePanel({
  token,
  onClose,
}: {
  token: TokenInfo | null
  onClose: () => void
}) {
  const { t } = useLanguage()
  const panelRef = useRef<HTMLDivElement>(null)

  useModalA11y({ open: !!token, onClose })

  const headerChange24h = token?.change24h ?? 0

  return (
    <>
      {token && (
        <>
          <div
            onClick={onClose}
            aria-label="Close panel"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--color-backdrop-light)',
              zIndex: tokens.zIndex.overlay,
              animation: 'fadeIn 0.2s ease-out',
            }}
          />
          <div
            style={{
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: tokens.zIndex.overlay + 1,
              pointerEvents: 'none',
            }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={`${token.symbol} token details`}
              style={{
                animation: 'fadeInScale 0.2s ease-out',
                width: 'min(95vw, 900px)',
                maxHeight: '90vh',
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.xl,
                overflowY: 'auto',
                padding: 'clamp(16px, 4vw, 28px)',
                pointerEvents: 'auto',
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {token.image ? (
                    <Image
                      src={token.image}
                      alt={`${token.symbol} icon`}
                      width={36}
                      height={36}
                      style={{ borderRadius: '50%' }}
                      unoptimized
                    />
                  ) : (
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        background: tokens.colors.bg.tertiary,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: tokens.typography.fontWeight.bold,
                        fontSize: tokens.typography.fontSize.base,
                        color: tokens.colors.text.secondary,
                      }}
                    >
                      {token.symbol.charAt(0)}
                    </span>
                  )}
                  <div>
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.lg,
                        fontWeight: tokens.typography.fontWeight.bold,
                        color: tokens.colors.text.primary,
                      }}
                    >
                      {token.symbol}
                    </div>
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: tokens.colors.text.tertiary,
                      }}
                    >
                      {token.name}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                      background: tokens.colors.bg.tertiary,
                      padding: '2px 8px',
                      borderRadius: tokens.radius.sm,
                      marginLeft: 4,
                    }}
                  >
                    #{token.rank}
                  </span>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close panel"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    width: 44,
                    height: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: tokens.colors.text.tertiary,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Price */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.hero,
                    fontWeight: tokens.typography.fontWeight.bold,
                    color: tokens.colors.text.primary,
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  {formatPrice(token.price)}
                </div>
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color:
                      headerChange24h >= 0
                        ? tokens.colors.accent.success
                        : tokens.colors.accent.error,
                  }}
                >
                  {headerChange24h >= 0 ? '+' : ''}
                  {headerChange24h.toFixed(2)}% (24h)
                </span>
              </div>

              {/* Retired OHLC acquisition */}
              <div
                role="status"
                style={{
                  marginBottom: 20,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  minHeight: 160,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 16,
                  background: tokens.colors.bg.tertiary,
                  color: tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.sm,
                  textAlign: 'center',
                }}
              >
                {t('dataUnavailable')}
              </div>

              {/* Market data */}
              <div style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: tokens.colors.text.primary,
                    marginBottom: 8,
                  }}
                >
                  {t('fundamentalData')}
                </div>
                <StatRow label={t('marketRank')} value={`${token.rank}`} />
                <StatRow label={t('tokenMarketCap')} value={formatNum(token.marketCap)} />
                <StatRow label={t('tokenVolume24h')} value={formatNum(token.volume24h)} />
                <StatRow label={t('tokenHigh24h')} value={formatPrice(token.high24h)} />
                <StatRow label={t('tokenLow24h')} value={formatPrice(token.low24h)} />
              </div>

              {/* Related Traders */}
              <div>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: tokens.colors.text.primary,
                    marginBottom: 8,
                  }}
                >
                  {t('relatedTraders')}
                </div>
                <div
                  style={{
                    padding: 16,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                    textAlign: 'center',
                    color: tokens.colors.text.tertiary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {t('noDataComingSoon')}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
