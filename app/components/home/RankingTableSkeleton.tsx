/**
 * RankingTableSkeleton - Server Component
 * Shows a skeleton of the ranking table before data loads.
 * This is rendered on the server and shown immediately to improve LCP.
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
              }}
            />
          ))}
        </div>
      </div>

      {/* Table rows skeleton */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: `${tokens.spacing[3]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.lg,
              background: i <= 3 ? `${tokens.colors.accent.primary}08` : 'transparent',
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
              }}
            />
            {/* Avatar */}
            <div
              className="skeleton"
              style={{
                width: 40,
                height: 40,
                borderRadius: tokens.radius.full,
                flexShrink: 0,
              }}
            />
            {/* Name + source */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="skeleton"
                style={{
                  width: '70%',
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  marginBottom: 6,
                }}
              />
              <div
                className="skeleton"
                style={{
                  width: '40%',
                  height: 12,
                  borderRadius: tokens.radius.sm,
                }}
              />
            </div>
            {/* Score */}
            <div
              className="skeleton"
              style={{
                width: 50,
                height: 32,
                borderRadius: tokens.radius.md,
                flexShrink: 0,
              }}
            />
            {/* ROI */}
            <div
              className="skeleton hide-mobile"
              style={{
                width: 70,
                height: 20,
                borderRadius: tokens.radius.sm,
                flexShrink: 0,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
