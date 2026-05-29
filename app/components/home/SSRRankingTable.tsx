/**
 * SSRRankingTable — Server-rendered mobile card layout.
 * Visually matches the React TraderCard component so the SSR→hydration
 * transition is invisible. Same card structure, same sizes, same colors.
 */

import type { InitialTrader } from '@/lib/getInitialTraders'
import { formatROI, formatPnL } from '@/lib/utils/format'

function getScoreStyle(score: number) {
  if (score >= 80)
    return { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)', color: '#22c55e' }
  if (score >= 60)
    return { bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.3)', color: '#a78bfa' }
  if (score >= 40)
    return { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', color: '#94a3b8' }
  return { bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.3)', color: '#64748b' }
}

function getInitial(name: string): string {
  if (!name) return '?'
  const clean = name.startsWith('@') ? name.slice(1) : name
  if (clean.startsWith('0x')) return clean.charAt(2).toUpperCase()
  return clean.charAt(0).toUpperCase()
}

const SOURCE_TYPE_COLORS: Record<string, string> = {
  futures: '#F59E0B',
  spot: '#3B82F6',
  web3: '#8B5CF6',
}

interface Props {
  traders: InitialTrader[]
  startRank?: number
}

export default async function SSRRankingTable({ traders, startRank = 0 }: Props) {
  if (!traders.length) {
    return (
      <div
        style={{
          padding: '48px 16px',
          textAlign: 'center',
          color: 'var(--color-text-tertiary, #888)',
        }}
      >
        <p style={{ fontSize: 16, marginBottom: 8 }}>Loading rankings... / 加载排名中...</p>
        <p style={{ fontSize: 13 }}>Data refreshes every few minutes / 数据每几分钟刷新一次</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {traders.map((trader, idx) => {
        const rank = startRank + idx + 1
        const roiVal = trader.roi ?? 0
        const roiPositive = roiVal >= 0
        const score = trader.arena_score != null ? Number(trader.arena_score).toFixed(0) : null
        const scoreStyle = trader.arena_score != null ? getScoreStyle(trader.arena_score) : null
        const typeColor = SOURCE_TYPE_COLORS[trader.source_type] || '#94a3b8'
        const typeLabel =
          trader.source_type === 'web3'
            ? 'On-chain'
            : trader.source_type === 'futures'
              ? 'Futures'
              : 'Spot'
        const winRate = trader.win_rate != null ? `${Number(trader.win_rate).toFixed(1)}%` : '—'
        const mdd =
          trader.max_drawdown != null
            ? Math.abs(trader.max_drawdown) < 0.05
              ? '< 0.1%'
              : `-${Math.abs(trader.max_drawdown).toFixed(1)}%`
            : '—'

        return (
          <a
            key={`${trader.source}-${trader.id}`}
            href={`/trader/${encodeURIComponent(trader.id)}?platform=${trader.source}`}
            className="ssr-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 16px',
              borderRadius: 12,
              background: 'var(--color-bg-secondary, #151320)',
              border: '1px solid var(--color-border-primary, #2C293A)',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            {/* Row 1: Rank + Avatar + Name + Score */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Rank */}
              <div style={{ minWidth: 32, textAlign: 'center' }}>
                {rank <= 3 ? (
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--color-bg-primary, #0B0A10)',
                      background:
                        rank === 1
                          ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                          : rank === 2
                            ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)'
                            : 'linear-gradient(135deg, #CD7F32, #A0522D)',
                    }}
                  >
                    {rank}
                  </span>
                ) : (
                  <span
                    style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-text-tertiary)' }}
                  >
                    {rank}
                  </span>
                )}
              </div>

              {/* Avatar */}
              <div
                style={{
                  width: 44,
                  height: 44,
                  minWidth: 44,
                  borderRadius: '50%',
                  background:
                    'linear-gradient(135deg, var(--color-accent-primary-30, rgba(139,111,168,0.3)), var(--color-pro-gold-border, #a78bfa))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  fontWeight: 700,
                  color: '#fff',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                {trader.avatar_url ? (
                  <img
                    src={`/api/avatar?url=${encodeURIComponent(trader.avatar_url)}`}
                    alt=""
                    loading={rank <= 3 ? 'eager' : 'lazy'}
                    {...(rank === 1 ? { fetchPriority: 'high' as const } : {})}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: '50%',
                      position: 'absolute',
                      inset: 0,
                    }}
                  />
                ) : (
                  getInitial(trader.handle)
                )}
              </div>

              {/* Name + Source */}
              <div
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--color-text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {trader.handle}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      padding: '1px 6px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: 1.4,
                      color: typeColor,
                      background: `${typeColor}15`,
                      border: `1px solid ${typeColor}30`,
                    }}
                  >
                    {typeLabel}
                  </span>
                </div>
              </div>

              {/* Score badge */}
              {score && scoreStyle && (
                <div
                  style={{
                    minWidth: 50,
                    height: 28,
                    borderRadius: 8,
                    background: scoreStyle.bg,
                    border: `1px solid ${scoreStyle.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 900,
                    color: scoreStyle.color,
                  }}
                >
                  {score}
                </div>
              )}
            </div>

            {/* Row 2: ROI bar + ROI value */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: roiPositive
                    ? `linear-gradient(90deg, #22c55e ${Math.min(100, Math.abs(roiVal) / 20)}%, transparent)`
                    : `linear-gradient(90deg, #ef4444 ${Math.min(100, Math.abs(roiVal) / 20)}%, transparent)`,
                  opacity: 0.7,
                }}
              />
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 900,
                  marginLeft: 'auto',
                  color: roiPositive ? '#22c55e' : '#ef4444',
                  letterSpacing: '-0.02em',
                }}
              >
                {formatROI(trader.roi)}
              </span>
            </div>

            {/* Row 3: Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {[
                { label: 'Sharpe', value: '—' },
                {
                  label: 'PnL',
                  value: formatPnL(trader.pnl),
                  color: trader.pnl != null ? (trader.pnl >= 0 ? '#22c55e' : '#ef4444') : undefined,
                },
                {
                  label: 'Win%',
                  value: winRate,
                  color: trader.win_rate != null && trader.win_rate > 50 ? '#22c55e' : undefined,
                },
                {
                  label: 'MDD',
                  value: mdd,
                  color: trader.max_drawdown != null ? '#ef4444' : undefined,
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    background: 'var(--color-bg-tertiary, #1C1926)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      letterSpacing: '0.04em',
                      opacity: 0.7,
                    }}
                  >
                    {stat.label}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: stat.color || 'var(--color-text-secondary)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>
          </a>
        )
      })}
    </div>
  )
}
