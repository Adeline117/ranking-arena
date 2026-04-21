'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import type { PersonalityType, RecommendedTrader } from '../../components/types'

/** Forced dark-theme palette */
const Q = {
  BG_CARD: '#161625',
  BG_TRADER: 'rgba(255,255,255,0.04)',
  BORDER: 'rgba(255,255,255,0.08)',
  HOVER_BG: 'rgba(255,255,255,0.06)',
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.5)',
  BULL: '#2FE57D',
  BEAR: '#FF5555',
  GOLD: '#D4AF37',
  ARROW: 'rgba(255,255,255,0.4)',
} as const

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
        background: Q.BG_CARD,
        border: `1px solid ${Q.BORDER}`,
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
            color: Q.TEXT_PRIMARY,
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
            href={`/trader/${encodeURIComponent(trader.handle)}?platform=${encodeURIComponent(trader.platform)}`}
            style={{
              padding: '12px 16px',
              borderRadius: 12,
              background: Q.BG_TRADER,
              border: `1px solid ${Q.BORDER}`,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              textDecoration: 'none',
              transition: 'border-color 0.2s, background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${type.color}40`
              e.currentTarget.style.background = Q.HOVER_BG
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = Q.BORDER
              e.currentTarget.style.background = Q.BG_TRADER
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
                  color: Q.TEXT_PRIMARY,
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
                  color: Q.TEXT_SECONDARY,
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
                      color: trader.roi_90d >= 0 ? Q.BULL : Q.BEAR,
                    }}
                  >
                    {trader.roi_90d >= 0 ? '+' : ''}
                    {trader.roi_90d.toFixed(1)}%
                  </div>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: Q.TEXT_SECONDARY,
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
                      color: Q.GOLD,
                    }}
                  >
                    {Math.round(trader.arena_score)}
                  </div>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: Q.TEXT_SECONDARY,
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
              stroke={Q.ARROW}
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
