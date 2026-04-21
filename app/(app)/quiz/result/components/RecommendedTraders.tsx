'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import type { PersonalityType, RecommendedTrader } from '../../components/types'

interface RecommendedTradersProps {
  type: PersonalityType
  traders: RecommendedTrader[]
  tr: (key: string) => string
}

export default function RecommendedTraders({ type, traders, tr }: RecommendedTradersProps) {
  if (!traders.length) return null

  return (
    <div
      style={{
        borderRadius: 12,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(16px, 3vw, 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 3,
            height: 20,
            borderRadius: 2,
            background: type.gradient,
          }}
        />
        <h3
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.bold,
            color: 'var(--color-text-primary)',
            margin: 0,
          }}
        >
          {tr('quizRecommendTitle')}
        </h3>
      </div>

      {/* Trader cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {traders.map((trader) => (
          <Link
            key={trader.handle}
            href={`/trader/${encodeURIComponent(trader.handle)}?platform=${encodeURIComponent(trader.platform)}`}
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--glass-border-light)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              textDecoration: 'none',
              transition: 'border-color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${type.color}40`
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--glass-border-light)'
            }}
          >
            {/* Avatar */}
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
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
                <img
                  src={trader.avatar_url}
                  alt={trader.name}
                  style={{ width: 36, height: 36, objectFit: 'cover' }}
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
              >
                {trader.name}
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
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    ROI
                  </div>
                </div>
              )}
              {trader.arena_score != null && (
                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: '#D4AF37',
                    }}
                  >
                    {Math.round(trader.arena_score)}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: '#D4AF37',
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
              style={{ flexShrink: 0 }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        ))}
      </div>
    </div>
  )
}
