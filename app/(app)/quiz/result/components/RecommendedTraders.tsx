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
        borderRadius: 16,
        background: 'var(--color-backdrop-heavy)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(20px, 4vw, 28px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 4,
            height: 24,
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {traders.map((trader) => (
          <Link
            key={trader.handle}
            href={`/trader/${trader.handle}`}
            style={{
              padding: '12px 16px',
              borderRadius: 12,
              background: 'var(--color-overlay-subtle)',
              border: '1px solid var(--glass-border-light)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              textDecoration: 'none',
              transition: 'border-color 0.2s, background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${type.color}40`
              e.currentTarget.style.background = 'var(--color-overlay-medium)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--glass-border-light)'
              e.currentTarget.style.background = 'var(--color-overlay-subtle)'
            }}
          >
            {/* Avatar */}
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: `${type.color}20`,
                border: `1px solid ${type.color}30`,
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
                  style={{ width: 40, height: 40, objectFit: 'cover' }}
                />
              ) : (
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.bold,
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
                  fontSize: tokens.typography.fontSize.base,
                  fontWeight: tokens.typography.fontWeight.semibold,
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
                  fontSize: tokens.typography.fontSize.xs,
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
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.bold,
                      color: trader.roi_90d >= 0 ? '#2FE57D' : '#FF5555',
                    }}
                  >
                    {trader.roi_90d >= 0 ? '+' : ''}
                    {trader.roi_90d.toFixed(1)}%
                  </div>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
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
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.bold,
                      color: '#D4AF37',
                    }}
                  >
                    {Math.round(trader.arena_score)}
                  </div>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    Score
                  </div>
                </div>
              )}
            </div>

            {/* Arrow */}
            <svg
              width="16"
              height="16"
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
