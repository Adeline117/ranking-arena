'use client'

import Image from 'next/image'
import Link from 'next/link'
import type { PersonalityType, RecommendedTrader } from '../../components/types'

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

export default function RecommendedTraders({ type, traders, tr }: RecommendedTradersProps) {
  return (
    <div className="quiz-section-card">
      {/* Section header */}
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: type.gradient }} />
        <h3 className="quiz-section-title">
          {tr('quizRecommendTitle')}
        </h3>
      </div>

      {/* Empty state */}
      {traders.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '20px 16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
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
              padding: '8px 20px',
              borderRadius: 20,
              background: `${type.color}15`,
              border: `1px solid ${type.color}25`,
              color: type.color,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              transition: 'opacity 0.2s',
            }}
          >
            {tr('quizFindTraders') !== 'quizFindTraders' ? tr('quizFindTraders') : 'Explore Rankings'}
          </Link>
        </div>
      )}

      {/* Trader cards */}
      {traders.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {traders.map((trader) => (
            <Link
              key={trader.handle}
              href={`/trader/${encodeURIComponent(trader.handle)}?platform=${encodeURIComponent(trader.platform)}`}
              aria-label={`View ${trader.name} on ${trader.platform.replace(/_/g, ' ')}`}
              style={{
                padding: '11px 14px',
                borderRadius: 10,
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--glass-border-light)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                textDecoration: 'none',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = `${type.color}40`
                e.currentTarget.style.transform = 'translateY(-1px)'
                e.currentTarget.style.boxShadow = `0 4px 12px ${type.color}15`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: `${type.color}15`,
                  border: `1px solid ${type.color}25`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  overflow: 'hidden',
                }}
              >
                {trader.avatar_url ? (
                  <Image
                    src={trader.avatar_url}
                    alt={`${trader.name} avatar`}
                    width={36}
                    height={36}
                    style={{ objectFit: 'cover' }}
                    unoptimized
                  />
                ) : (
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: type.color,
                    }}
                  >
                    {trader.name.charAt(0).toUpperCase()}
                  </span>
                )}
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
                    fontSize: 12,
                    color: 'var(--color-text-tertiary)',
                    textTransform: 'capitalize',
                  }}
                >
                  {trader.platform.replace(/_/g, ' ')}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                {trader.roi_90d != null && (
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: trader.roi_90d >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
                      }}
                    >
                      {trader.roi_90d >= 0 ? '+' : ''}
                      {trader.roi_90d.toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                      ROI
                    </div>
                  </div>
                )}
                {trader.arena_score != null && trader.arena_score > 0 && (
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: 'var(--color-rank-gold)',
                      }}
                    >
                      {Math.round(trader.arena_score)}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-rank-gold)' }}>
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
                style={{ flexShrink: 0 }}
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
