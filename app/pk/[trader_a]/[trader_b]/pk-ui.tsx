/**
 * Presentational UI components for the PK comparison page.
 * All server-compatible (no 'use client' needed).
 */

import Link from 'next/link'
import type { PKTraderData, MetricRow, OverallResult } from './pk-types'

// ─── Design tokens ──────────────────────────────────────────────────────────

export const COLOR = {
  bg: '#0A0912',
  card: '#12111A',
  border: 'rgba(139,111,168,0.2)',
  text: '#EDEDED',
  sub: '#888888',
  brand: '#8b6fa8',
  gold: '#FFD700',
  success: '#4DFF9A',
  error: '#FF4D4D',
  winnerGold: '#FFD700',
  loser: 'rgba(237,237,237,0.35)',
}

// ─── Avatar ─────────────────────────────────────────────────────────────────

interface AvatarInitialProps {
  name: string
  gradient?: string
  size?: number
}

export function AvatarInitial({
  name,
  gradient = 'linear-gradient(135deg, #8b6fa8 0%, #6366f1 100%)',
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
        fontWeight: 900,
        color: '#fff',
        flexShrink: 0,
        boxShadow: '0 0 20px rgba(139,111,168,0.3)',
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
    ? 'linear-gradient(135deg, rgba(139,111,168,0.1) 0%, rgba(139,111,168,0.04) 100%)'
    : 'linear-gradient(225deg, rgba(99,102,241,0.1) 0%, rgba(99,102,241,0.04) 100%)'
  const borderColor = isA
    ? 'rgba(139,111,168,0.3)'
    : 'rgba(99,102,241,0.3)'
  const borderRadius = isA ? '16px 0 0 16px' : '0 16px 16px 0'
  const avatarGradient = isA
    ? 'linear-gradient(135deg, #8b6fa8 0%, #6366f1 100%)'
    : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'
  const rankColor = isA ? COLOR.gold : '#818cf8'
  const linkColor = isA ? COLOR.brand : '#818cf8'

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
              fontSize: 20,
              fontWeight: 800,
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
                fontSize: 12,
                color: rankColor,
                fontWeight: 700,
              }}
            >
              #{data.rank} Ranked
            </div>
          )}
          <Link
            href={`/trader/${encodeURIComponent(handle)}`}
            style={{
              fontSize: 12,
              color: linkColor,
              textDecoration: 'none',
              marginTop: 4,
            }}
          >
            View Profile
          </Link>
        </>
      ) : (
        <div style={{ color: COLOR.sub, fontSize: 14 }}>
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
        background: 'rgba(255,215,0,0.04)',
        borderTop: '1px solid rgba(255,215,0,0.15)',
        borderBottom: '1px solid rgba(255,215,0,0.15)',
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 900,
          color: COLOR.gold,
          letterSpacing: -3,
          lineHeight: 1,
          textShadow: '0 0 30px rgba(255,215,0,0.5)',
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
        borderRadius: 16,
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
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
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
            fontSize: 11,
            fontWeight: 700,
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
            fontSize: 11,
            fontWeight: 700,
            color: '#818cf8',
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
          ? '1px solid rgba(255,255,255,0.04)'
          : 'none',
        background: aWins
          ? 'rgba(255,215,0,0.025)'
          : bWins
          ? 'rgba(99,102,241,0.025)'
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
              boxShadow: '0 0 6px rgba(255,215,0,0.8)',
            }}
          />
        )}
        <span
          style={{
            fontSize: 20,
            fontWeight: 800,
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
              borderRadius: 20,
              background: 'rgba(255,215,0,0.15)',
              border: '1px solid rgba(255,215,0,0.4)',
              fontSize: 10,
              fontWeight: 700,
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
          fontSize: 11,
          fontWeight: 700,
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
              background: '#818cf8',
              flexShrink: 0,
              boxShadow: '0 0 6px rgba(129,140,248,0.8)',
            }}
          />
        )}
        <span
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: bWins
              ? '#818cf8'
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
              borderRadius: 20,
              background: 'rgba(129,140,248,0.15)',
              border: '1px solid rgba(129,140,248,0.4)',
              fontSize: 10,
              fontWeight: 700,
              color: '#818cf8',
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
            ? 'linear-gradient(135deg, rgba(255,215,0,0.08) 0%, rgba(255,215,0,0.03) 100%)'
            : overall.winner === nameB
            ? 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(99,102,241,0.03) 100%)'
            : 'rgba(255,255,255,0.03)',
        border:
          overall.winner === nameA
            ? '1px solid rgba(255,215,0,0.3)'
            : overall.winner === nameB
            ? '1px solid rgba(99,102,241,0.3)'
            : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 16,
      }}
    >
      <div
        style={{
          fontSize: 12,
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
          fontSize: 32,
          fontWeight: 900,
          color:
            overall.winner === nameA
              ? COLOR.gold
              : overall.winner === nameB
              ? '#818cf8'
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
            fontSize: 14,
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
