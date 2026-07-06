'use client'

import Image from 'next/image'
import Link from 'next/link'
import type { PersonalityType, RecommendedTrader } from '../../components/types'
import { alpha } from '@/lib/design-tokens'

interface RecommendedTradersProps {
  type: PersonalityType
  traders: RecommendedTrader[]
  tr: (key: string) => string
}

/** Smart truncation for hex addresses: 0x1234...abcd */
function formatTraderName(name: string): string {
  if (name.startsWith('0x') && name.length > 12) {
    return `${name.slice(0, 6)}...${name.slice(-4)}`
  }
  return name
}

// The ingest pipeline clamps ROI to ±10000 (lib/ingest/staging/validate.ts).
// A value that hits that ceiling is a sentinel, NOT a real +10000.0% return —
// showing it verbatim (as several Hyperliquid rows did) reads as fake precision.
// Anything at/above the clamp is rendered as an "Extreme" tag instead.
const ROI_CLAMP_CEILING = 10000
function isRoiClamped(roi: number): boolean {
  return Math.abs(roi) >= ROI_CLAMP_CEILING
}

export default function RecommendedTraders({ type, traders, tr }: RecommendedTradersProps) {
  return (
    <div className="quiz-section-card">
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: type.gradient }} />
        <h3 className="quiz-section-title">{tr('quizRecommendTitle')}</h3>
      </div>

      {/* Empty state */}
      {traders.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '24px 16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <p
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary)',
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            {tr('quizNoTradersFound') !== 'quizNoTradersFound'
              ? tr('quizNoTradersFound')
              : 'No matching traders found yet. Check out our rankings to discover traders.'}
          </p>
          <Link
            href="/rankings"
            style={{
              padding: '10px 24px',
              borderRadius: 24,
              background: type.gradient,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              textDecoration: 'none',
              boxShadow: `0 4px 16px ${alpha(type.color, 19)}`,
              transition: 'transform 0.2s, box-shadow 0.2s',
            }}
          >
            {tr('quizFindTraders') !== 'quizFindTraders'
              ? tr('quizFindTraders')
              : 'Explore Rankings'}
          </Link>
        </div>
      )}

      {traders.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {traders.map((trader) => (
            <Link
              key={trader.handle}
              href={`/trader/${encodeURIComponent(trader.handle)}?platform=${encodeURIComponent(trader.platform)}`}
              aria-label={`View ${trader.name} on ${trader.platform.replace(/_/g, ' ')}`}
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--glass-border-light)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                textDecoration: 'none',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = `${alpha(type.color, 25)}`
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = `0 4px 16px ${alpha(type.color, 7)}`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              {/* Avatar with type-colored ring */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: type.gradient,
                  padding: 2,
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: 10,
                    background: `${alpha(type.color, 8)}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {trader.avatar_url ? (
                    <Image
                      src={trader.avatar_url}
                      alt={`${trader.name} avatar`}
                      width={36}
                      height={36}
                      style={{ objectFit: 'cover', width: '100%', height: '100%' }}
                      unoptimized
                    />
                  ) : (
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>
                      {trader.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={trader.name}
                >
                  {formatTraderName(trader.name)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-tertiary)',
                    textTransform: 'capitalize',
                    marginTop: 1,
                  }}
                >
                  {trader.platform.replace(/_/g, ' ')}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: 'flex', gap: 14, flexShrink: 0 }}>
                {trader.roi_90d != null && (
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: isRoiClamped(trader.roi_90d)
                          ? 'var(--color-text-tertiary)'
                          : trader.roi_90d >= 0
                            ? 'var(--color-accent-success)'
                            : 'var(--color-accent-error)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                      title={isRoiClamped(trader.roi_90d) ? `${trader.roi_90d}%` : undefined}
                    >
                      {isRoiClamped(trader.roi_90d) ? (
                        tr('quizRoiExtreme')
                      ) : (
                        <>
                          {trader.roi_90d >= 0 ? '+' : ''}
                          {trader.roi_90d.toFixed(1)}%
                        </>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--color-text-tertiary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.8px',
                        marginTop: 1,
                      }}
                    >
                      ROI
                    </div>
                  </div>
                )}
                {trader.arena_score != null && trader.arena_score > 0 && (
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: '#FFD700',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {Math.round(trader.arena_score)}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: '#FFD700',
                        textTransform: 'uppercase',
                        letterSpacing: '0.8px',
                        marginTop: 1,
                        opacity: 0.7,
                      }}
                    >
                      Score
                    </div>
                  </div>
                )}
              </div>

              {/* Arrow */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-text-tertiary)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, opacity: 0.5 }}
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
