/**
 * RankingTableSkeleton - Server Component
 * Shows a skeleton of the ranking table before data loads.
 * This is rendered on the server and shown immediately to improve LCP.
 * Staggered animation-delay gives a cascading shimmer effect.
 */

import { tokens } from '@/lib/design-tokens'

export default function RankingTableSkeleton() {
  return (
    <div
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[4],
        overflow: 'hidden',
      }}
    >
      {/* Header skeleton */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
          paddingBottom: tokens.spacing[3],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <div
          className="skeleton"
          style={{
            width: 120,
            height: 24,
            borderRadius: tokens.radius.md,
          }}
        />
        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="skeleton"
              style={{
                width: 60,
                height: 32,
                borderRadius: tokens.radius.md,
                animationDelay: `${i * 80}ms`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Table rows skeleton */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: `${tokens.spacing[3]} ${tokens.spacing[2]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: i <= 3 ? `${tokens.colors.accent.primary}06` : 'transparent',
            }}
          >
            {/* Rank */}
            <div
              className="skeleton"
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.full,
                flexShrink: 0,
                animationDelay: `${i * 60}ms`,
              }}
            />
            {/* Avatar */}
            <div
              className="skeleton"
              style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.full,
                flexShrink: 0,
                animationDelay: `${i * 60 + 30}ms`,
              }}
            />
            {/* Name + source */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="skeleton"
                style={{
                  width: `${65 + (i % 3) * 10}%`,
                  height: 14,
                  borderRadius: tokens.radius.sm,
                  marginBottom: 8,
                  animationDelay: `${i * 60 + 60}ms`,
                }}
              />
              <div
                className="skeleton"
                style={{
                  width: `${30 + (i % 4) * 8}%`,
                  height: 10,
                  borderRadius: tokens.radius.sm,
                  animationDelay: `${i * 60 + 90}ms`,
                }}
              />
            </div>
            {/* Score */}
            <div
              className="skeleton"
              style={{
                width: 48,
                height: 28,
                borderRadius: tokens.radius.md,
                flexShrink: 0,
                animationDelay: `${i * 60 + 120}ms`,
              }}
            />
            {/* ROI */}
            <div
              className="skeleton hide-mobile"
              style={{
                width: 68,
                height: 18,
                borderRadius: tokens.radius.sm,
                flexShrink: 0,
                animationDelay: `${i * 60 + 150}ms`,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
