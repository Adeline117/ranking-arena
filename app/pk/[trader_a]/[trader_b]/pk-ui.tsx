/**
 * Presentational UI components for the PK comparison page.
 * All server-compatible (no 'use client' needed).
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import type { PKTraderData, MetricRow, OverallResult } from './pk-types'

// ─── Design tokens ──────────────────────────────────────────────────────────

export const COLOR = {
  bg: 'var(--color-bg-primary)',
  card: 'var(--color-bg-secondary)',
  border: 'var(--color-border-primary)',
  text: 'var(--color-text-primary)',
  sub: 'var(--color-text-tertiary)',
  brand: 'var(--color-brand)',
  gold: 'var(--color-accent-warning, #FFD700)',
  success: 'var(--color-accent-success)',
  error: 'var(--color-accent-error)',
  winnerGold: 'var(--color-accent-warning, #FFD700)',
  loser: 'var(--color-text-tertiary)',
  sideB: 'var(--color-accent-primary)',
}

// ─── Avatar ─────────────────────────────────────────────────────────────────

interface AvatarInitialProps {
  name: string
  gradient?: string
  size?: number
}

export function AvatarInitial({
  name,
  gradient = 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-accent-primary) 100%)',
  size = 64,
}: AvatarInitialProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        fontWeight: tokens.typography.fontWeight.black,
        color: 'var(--color-on-accent, #fff)',
        flexShrink: 0,
        boxShadow: tokens.shadow.glow,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Fighter Card ───────────────────────────────────────────────────────────

interface FighterCardProps {
  data: PKTraderData | null
  displayName: string
  handle: string
  side: 'a' | 'b'
}

export function FighterCard({ data, displayName, handle, side }: FighterCardProps) {
  const isA = side === 'a'
  const gradient = isA
    ? 'linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 10%, transparent) 0%, color-mix(in srgb, var(--color-brand) 4%, transparent) 100%)'
    : 'linear-gradient(225deg, color-mix(in srgb, var(--color-accent-primary) 10%, transparent) 0%, color-mix(in srgb, var(--color-accent-primary) 4%, transparent) 100%)'
  const borderColor = isA
    ? 'color-mix(in srgb, var(--color-brand) 30%, transparent)'
    : 'color-mix(in srgb, var(--color-accent-primary) 30%, transparent)'
  const borderRadius = isA ? `${tokens.radius.xl} 0 0 ${tokens.radius.xl}` : `0 ${tokens.radius.xl} ${tokens.radius.xl} 0`
  const avatarGradient = isA
    ? 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-accent-primary) 100%)'
    : 'linear-gradient(135deg, var(--color-accent-primary) 0%, var(--color-pro-gradient-start, #8b5cf6) 100%)'
  const rankColor = isA ? COLOR.gold : COLOR.sideB
  const linkColor = isA ? COLOR.brand : COLOR.sideB

  return (
    <div
      style={{
        background: gradient,
        border: `1px solid ${borderColor}`,
        borderRadius,
        padding: '28px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        position: 'relative',
      }}
    >
      {data ? (
        <>
          <AvatarInitial
            name={displayName}
            gradient={avatarGradient}
            size={72}
          />
          <div
            style={{
              fontSize: tokens.typography.fontSize.xl,
              fontWeight: tokens.typography.fontWeight.extrabold,
              color: COLOR.text,
              textAlign: 'center',
            }}
          >
            {displayName.length > 18
              ? displayName.slice(0, 18) + '...'
              : displayName}
          </div>
          {data.rank != null && (
            <div
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: rankColor,
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              #{data.rank} Ranked
            </div>
          )}
          <Link
            href={`/trader/${encodeURIComponent(handle)}`}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: linkColor,
              textDecoration: 'none',
              marginTop: 4,
            }}
          >
            View Profile
          </Link>
        </>
      ) : (
        <div style={{ color: COLOR.sub, fontSize: tokens.typography.fontSize.base }}>
          Trader not found
        </div>
      )}
    </div>
  )
}

// ─── VS Divider ─────────────────────────────────────────────────────────────

export function VSDivider() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '28px 24px',
        background: 'color-mix(in srgb, var(--color-accent-warning, #FFD700) 4%, transparent)',
        borderTop: '1px solid color-mix(in srgb, var(--color-accent-warning, #FFD700) 15%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--color-accent-warning, #FFD700) 15%, transparent)',
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: tokens.typography.fontWeight.black,
          color: COLOR.gold,
          letterSpacing: -3,
          lineHeight: 1,
          textShadow: tokens.shadow.glowWarning,
        }}
      >
        VS
      </div>
    </div>
  )
}

// ─── Metrics Comparison Table ───────────────────────────────────────────────

interface MetricsTableProps {
  metrics: MetricRow[]
  nameA: string
  nameB: string
}

export function MetricsTable({ metrics, nameA, nameB }: MetricsTableProps) {
  return (
    <div
      style={{
        background: COLOR.card,
        border: `1px solid ${COLOR.border}`,
        borderRadius: tokens.radius.xl,
        overflow: 'hidden',
        marginBottom: 32,
      }}
    >
      {/* Table header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 120px 1fr',
          padding: '12px 24px',
          borderBottom: '1px solid var(--glass-border-light)',
          background: 'var(--glass-bg-light)',
        }}
      >
        <div
          style={{
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.bold,
            color: COLOR.brand,
            letterSpacing: 2,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          {nameA.length > 14 ? nameA.slice(0, 14) + '...' : nameA}
        </div>
        <div
          style={{
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.bold,
            color: COLOR.sub,
            letterSpacing: 2,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          METRIC
        </div>
        <div
          style={{
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.bold,
            color: COLOR.sideB,
            letterSpacing: 2,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          {nameB.length > 14 ? nameB.slice(0, 14) + '...' : nameB}
        </div>
      </div>

      {/* Metric rows */}
      {metrics.map((m, i) => (
        <MetricRowItem
          key={m.label}
          metric={m}
          isLast={i === metrics.length - 1}
        />
      ))}
    </div>
  )
}

// ─── Single Metric Row ──────────────────────────────────────────────────────

interface MetricRowItemProps {
  metric: MetricRow
  isLast: boolean
}

function MetricRowItem({ metric: m, isLast }: MetricRowItemProps) {
  const aWins = m.winner === 'a'
  const bWins = m.winner === 'b'

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 120px 1fr',
        padding: '16px 24px',
        borderBottom: !isLast
          ? '1px solid var(--glass-border-light)'
          : 'none',
        background: aWins
          ? 'color-mix(in srgb, var(--color-accent-warning, #FFD700) 2.5%, transparent)'
          : bWins
          ? 'color-mix(in srgb, var(--color-accent-primary) 2.5%, transparent)'
          : 'transparent',
        alignItems: 'center',
      }}
    >
      {/* Trader A value */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {aWins && (
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: COLOR.gold,
              flexShrink: 0,
              boxShadow: tokens.shadow.glowWarning,
            }}
          />
        )}
        <span
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: tokens.typography.fontWeight.extrabold,
            color: aWins
              ? COLOR.winnerGold
              : bWins
              ? COLOR.loser
              : COLOR.text,
            fontFamily:
              '"SF Mono", "Fira Code", "Cascadia Code", monospace',
            letterSpacing: -0.5,
          }}
        >
          {m.a_display}
        </span>
        {aWins && (
          <div
            style={{
              padding: '2px 7px',
              borderRadius: tokens.radius.full,
              background: 'color-mix(in srgb, var(--color-accent-warning, #FFD700) 15%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-accent-warning, #FFD700) 40%, transparent)',
              fontSize: 10,
              fontWeight: tokens.typography.fontWeight.bold,
              color: COLOR.gold,
              letterSpacing: 1,
            }}
          >
            WIN
          </div>
        )}
      </div>

      {/* Center metric label */}
      <div
        style={{
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.bold,
          color: COLOR.sub,
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}
      >
        {m.label}
      </div>

      {/* Trader B value */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          flexDirection: 'row-reverse',
        }}
      >
        {bWins && (
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: COLOR.sideB,
              flexShrink: 0,
              boxShadow: tokens.shadow.glow,
            }}
          />
        )}
        <span
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: tokens.typography.fontWeight.extrabold,
            color: bWins
              ? COLOR.sideB
              : aWins
              ? COLOR.loser
              : COLOR.text,
            fontFamily:
              '"SF Mono", "Fira Code", "Cascadia Code", monospace',
            letterSpacing: -0.5,
          }}
        >
          {m.b_display}
        </span>
        {bWins && (
          <div
            style={{
              padding: '2px 7px',
              borderRadius: tokens.radius.full,
              background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-accent-primary) 40%, transparent)',
              fontSize: 10,
              fontWeight: tokens.typography.fontWeight.bold,
              color: COLOR.sideB,
              letterSpacing: 1,
            }}
          >
            WIN
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Winner Banner ──────────────────────────────────────────────────────────

interface WinnerBannerProps {
  overall: OverallResult
  nameA: string
  nameB: string
}

export function WinnerBanner({ overall, nameA, nameB }: WinnerBannerProps) {
  if (!overall.winner) return null

  return (
    <div
      style={{
        textAlign: 'center',
        padding: '28px 24px',
        marginBottom: 32,
        background:
          overall.winner === nameA
            ? 'linear-gradient(135deg, color-mix(in srgb, var(--color-accent-warning, #FFD700) 8%, transparent) 0%, color-mix(in srgb, var(--color-accent-warning, #FFD700) 3%, transparent) 100%)'
            : overall.winner === nameB
            ? 'linear-gradient(135deg, color-mix(in srgb, var(--color-accent-primary) 8%, transparent) 0%, color-mix(in srgb, var(--color-accent-primary) 3%, transparent) 100%)'
            : 'var(--glass-bg-light)',
        border:
          overall.winner === nameA
            ? '1px solid color-mix(in srgb, var(--color-accent-warning, #FFD700) 30%, transparent)'
            : overall.winner === nameB
            ? '1px solid color-mix(in srgb, var(--color-accent-primary) 30%, transparent)'
            : '1px solid var(--glass-border-light)',
        borderRadius: tokens.radius.xl,
      }}
    >
      <div
        style={{
          fontSize: tokens.typography.fontSize.xs,
          letterSpacing: 4,
          color: COLOR.sub,
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        {overall.winner === 'TIE'
          ? 'RESULT'
          : `${overall.aWins} vs ${overall.bWins} metrics`}
      </div>
      <div
        style={{
          fontSize: tokens.typography.fontSize['3xl'],
          fontWeight: tokens.typography.fontWeight.black,
          color:
            overall.winner === nameA
              ? COLOR.gold
              : overall.winner === nameB
              ? COLOR.sideB
              : COLOR.sub,
          letterSpacing: -1,
        }}
      >
        {overall.winner === 'TIE'
          ? 'TIED'
          : `Winner: ${overall.winner}`}
      </div>
      {overall.winner !== 'TIE' && (
        <div
          style={{
            marginTop: 8,
            fontSize: tokens.typography.fontSize.base,
            color: COLOR.sub,
          }}
        >
          wins{' '}
          {overall.winner === nameA ? overall.aWins : overall.bWins}/
          {overall.total} metrics
        </div>
      )}
    </div>
  )
}
