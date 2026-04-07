/**
 * SSRRankingTable - Simple row-based ranking list.
 * Each trader = one row: Rank | Avatar+Name | Score | ROI+PnL
 * No grid columns, no hide-mobile — one consistent layout across all devices.
 */

import type { InitialTrader } from '@/lib/getInitialTraders'
import { formatROI, formatPnL } from '@/lib/utils/format'

function getScoreColor(score: number): string {
  if (score >= 90) return 'ssr-score-s'
  if (score >= 80) return 'ssr-score-a'
  if (score >= 70) return 'ssr-score-b'
  if (score >= 50) return 'ssr-score-c'
  return 'ssr-score-d'
}

function getInitial(name: string): string {
  if (!name) return '?'
  const clean = name.startsWith('@') ? name.slice(1) : name
  if (clean.startsWith('0x')) return clean.charAt(2).toUpperCase()
  return clean.charAt(0).toUpperCase()
}

interface Props {
  traders: InitialTrader[]
  startRank?: number
}

export default function SSRRankingTable({ traders, startRank = 0 }: Props) {
  if (!traders.length) {
    return (
      <div style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--color-text-tertiary, #888)' }}>
        <p style={{ fontSize: 16, marginBottom: 8 }}>Loading ranking data...</p>
        <p style={{ fontSize: 13 }}>Data refreshes automatically. Try refreshing in a moment.</p>
      </div>
    )
  }

  return (
    <>
      {traders.map((trader, idx) => {
        const rank = startRank + idx + 1
        const roiVal = trader.roi ?? 0
        const roiPositive = roiVal >= 0

        return (
          <a
            key={`${trader.source}-${trader.id}`}
            href={`/trader/${encodeURIComponent(trader.id)}?platform=${trader.source}`}
            className={`ssr-row${rank === 1 ? ' ssr-row-gold' : rank === 2 ? ' ssr-row-silver' : rank === 3 ? ' ssr-row-bronze' : ''}`}
          >
            {/* Rank */}
            <span className={`ssr-rank${rank <= 3 ? '' : ' ssr-rank-default'}`}>
              {rank <= 3 ? (
                <span
                  className="ssr-rank-circle"
                  style={{
                    background: rank === 1
                      ? 'linear-gradient(135deg, var(--color-rank-gold, #FFD700), #FFA500)'
                      : rank === 2
                      ? 'linear-gradient(135deg, var(--color-rank-silver, #C0C0C0), #A0A0A0)'
                      : 'linear-gradient(135deg, var(--color-rank-bronze, #CD7F32), #A0522D)',
                  }}
                >
                  {rank}
                </span>
              ) : rank}
            </span>

            {/* Avatar + Name + Platform */}
            <div className="ssr-info">
              <div className="ssr-av">{getInitial(trader.handle)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ssr-name">{trader.handle}</div>
                <div className="ssr-src">{trader.source_type}</div>
              </div>
            </div>

            {/* Score */}
            <span className={`ssr-score ${trader.arena_score != null ? getScoreColor(trader.arena_score) : ''}`}>
              {trader.arena_score != null ? Number(trader.arena_score).toFixed(0) : '—'}
            </span>

            {/* ROI + PnL */}
            <div className="ssr-roi">
              <div className={`ssr-roi-val ${roiPositive ? 'ssr-roi-pos' : 'ssr-roi-neg'}`}>
                {formatROI(trader.roi)}
              </div>
              <div className="ssr-pnl">{formatPnL(trader.pnl)}</div>
            </div>
          </a>
        )
      })}
    </>
  )
}
