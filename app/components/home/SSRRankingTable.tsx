/**
 * SSRRankingTable - Pure Server Component
 * Renders the top traders as static HTML for instant LCP.
 * No JavaScript needed to display — painted by browser immediately.
 * The client-side RankingTable takes over after hydration.
 */

import { tokens } from '@/lib/design-tokens'
import type { InitialTrader } from '@/lib/getInitialTraders'

// Score color logic (server-side, no hooks)
function getScoreColor(score: number): string {
  if (score >= 90) return '#22c55e'
  if (score >= 80) return '#4ade80'
  if (score >= 70) return '#a78bfa'
  if (score >= 50) return '#94a3b8'
  return '#64748b'
}

function formatROI(roi: number): string {
  if (roi >= 1000) return `+${(roi / 1000).toFixed(1)}K%`
  if (roi >= 0) return `+${roi.toFixed(0)}%`
  return `${roi.toFixed(0)}%`
}

function formatPnL(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function getInitial(name: string): string {
  if (!name) return '?'
  // Skip @ prefix
  const clean = name.startsWith('@') ? name.slice(1) : name
  // For addresses, use first char after 0x
  if (clean.startsWith('0x')) return clean.charAt(2).toUpperCase()
  return clean.charAt(0).toUpperCase()
}

interface Props {
  traders: InitialTrader[]
}

export default function SSRRankingTable({ traders }: Props) {
  if (!traders.length) return null

  const RANK_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32']

  return (
    <div
      id="ssr-ranking-table"
      style={{
        background: 'var(--color-bg-secondary)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr 60px 80px 60px 60px',
        padding: '10px 16px',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-tertiary)',
        borderBottom: '1px solid var(--color-border-primary)',
        gap: 8,
      }}>
        <span>RANK</span>
        <span>TRADER</span>
        <span style={{ textAlign: 'right' }}>SCORE</span>
        <span style={{ textAlign: 'right' }}>ROI</span>
        <span className="hide-mobile" style={{ textAlign: 'right' }}>WIN%</span>
        <span className="hide-mobile" style={{ textAlign: 'right' }}>MDD</span>
      </div>

      {/* Trader rows */}
      {traders.slice(0, 25).map((trader, idx) => {
        const rank = idx + 1
        const isTop3 = rank <= 3
        const roiColor = trader.roi >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
        const initial = getInitial(trader.handle)

        return (
          <a
            key={`${trader.source}-${trader.id}`}
            href={`/trader/${encodeURIComponent(trader.id)}?platform=${trader.source}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 60px 80px 60px 60px',
              padding: '10px 16px',
              gap: 8,
              alignItems: 'center',
              textDecoration: 'none',
              color: 'inherit',
              borderBottom: '1px solid var(--color-border-primary)',
              background: isTop3 ? 'var(--color-accent-primary-06, rgba(139,92,246,0.06))' : 'transparent',
              minHeight: 52,
            }}
          >
            {/* Rank */}
            <span style={{
              fontSize: 13,
              fontWeight: 800,
              color: isTop3 ? RANK_COLORS[rank - 1] : 'var(--color-text-tertiary)',
              textAlign: 'center',
            }}>
              {rank}
            </span>

            {/* Avatar + Name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{
                width: 36,
                height: 36,
                minWidth: 36,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border, #a78bfa))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: '#fff',
                overflow: 'hidden',
                position: 'relative',
              }}>
                {initial}
                {trader.avatar_url && (
                  <img
                    src={`/api/avatar?url=${encodeURIComponent(trader.avatar_url)}`}
                    alt=""
                    width={36}
                    height={36}
                    loading={rank <= 3 ? 'eager' : 'lazy'}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      position: 'absolute',
                      inset: 0,
                    }}
                  />
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {trader.handle}
                </div>
                <div style={{
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  textTransform: 'capitalize',
                }}>
                  {trader.source_type}
                </div>
              </div>
            </div>

            {/* Score */}
            <span style={{
              textAlign: 'right',
              fontSize: 13,
              fontWeight: 700,
              color: getScoreColor(trader.arena_score),
            }}>
              {trader.arena_score.toFixed(0)}
            </span>

            {/* ROI */}
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: roiColor }}>
                {formatROI(trader.roi)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {formatPnL(trader.pnl)}
              </div>
            </div>

            {/* Win Rate */}
            <span className="hide-mobile" style={{
              textAlign: 'right',
              fontSize: 12,
              color: 'var(--color-text-secondary)',
            }}>
              {trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : '--'}
            </span>

            {/* MDD */}
            <span className="hide-mobile" style={{
              textAlign: 'right',
              fontSize: 12,
              color: 'var(--color-danger)',
            }}>
              {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(1)}%` : '--'}
            </span>
          </a>
        )
      })}
    </div>
  )
}
