/**
 * SSRRankingTable — Server-rendered ranking shell.
 *
 * One row DOM serves both viewports: desktop gets the same grid information
 * architecture as RankingTable, while CSS reflows those cells into the
 * hydrated TraderCard layout on mobile. Keeping a single link/value tree avoids
 * duplicate accessible content and the old mobile-card → desktop-table flash.
 */

import type { CSSProperties } from 'react'
import type { InitialTrader } from '@/lib/getInitialTraders'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import Metric from '@/app/components/ui/Metric'
import ScoreMiniBar from '@/app/components/ranking/ScoreMiniBar'
import { getStaticTranslation } from '@/lib/i18n/server'

function getInitial(name: string): string {
  if (!name) return '?'
  const clean = name.startsWith('@') ? name.slice(1) : name
  if (clean.startsWith('0x')) return clean.charAt(2).toUpperCase()
  return clean.charAt(0).toUpperCase()
}

function getSourceTypeLabel(sourceType: InitialTrader['source_type']): string {
  if (sourceType === 'web3') return 'On-chain'
  if (sourceType === 'futures') return 'Futures'
  return 'Spot'
}

function getDrawdownDisplay(value: number | null): string {
  if (value == null) return '—'
  return Math.abs(value) < 0.05 ? '< 0.1%' : `-${Math.abs(value).toFixed(1)}%`
}

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return <span className={`ssr-rank-medal ssr-rank-medal-${rank}`}>{rank}</span>
  }

  return <span className="ssr-rank-number">{rank}</span>
}

interface Props {
  traders: InitialTrader[]
  startRank?: number
}

export default async function SSRRankingTable({ traders, startRank = 0 }: Props) {
  // Keep the cacheable shell language-independent. The client tree localizes
  // after hydration, matching the rest of the homepage's static SSR strategy.
  const { t } = getStaticTranslation()
  if (!traders.length) {
    return (
      <div className="ssr-ranking-empty">
        <p>Loading rankings... / 加载排名中...</p>
        <p>Data refreshes every few minutes / 数据每几分钟刷新一次</p>
      </div>
    )
  }

  return (
    <section className="ssr-ranking-table" aria-label="Trader rankings">
      <div className="ssr-ranking-header ssr-ranking-grid" aria-hidden="true">
        <span>Rank</span>
        <span>Trader</span>
        <span>Score</span>
        <span>ROI (90D)</span>
        <span>PnL</span>
        <span>Win</span>
        <span>MDD</span>
      </div>

      <div className="ssr-ranking-body">
        {traders.map((trader, idx) => {
          const rank = startRank + idx + 1
          const roi = trader.roi ?? 0
          const score =
            trader.arena_score != null && Number.isFinite(Number(trader.arena_score))
              ? Number(trader.arena_score)
              : null
          const scoreStyle = score != null ? getScoreColorInfo(score) : null
          const winRate =
            trader.win_rate != null
              ? `${Number(trader.win_rate).toFixed(1)}%`
              : trader.trades_count === 0
                ? t('holderBadge')
                : '—'
          const drawdownDisplay = getDrawdownDisplay(trader.max_drawdown)
          const href = `/trader/${encodeURIComponent(trader.id)}?platform=${encodeURIComponent(trader.source)}`

          return (
            <a
              key={`${trader.source}-${trader.id}`}
              href={href}
              className={`ssr-ranking-entry ssr-ranking-grid${rank <= 3 ? ` ssr-ranking-entry-rank-${rank}` : ''}`}
              aria-label={`Rank ${rank}: ${trader.handle}. Arena Score ${score != null ? score.toFixed(0) : 'not available'}, ROI ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`}
            >
              <div className="ssr-rank-cell">
                <RankBadge rank={rank} />
              </div>

              <div className="ssr-trader-cell">
                <span className="ssr-trader-avatar" aria-hidden="true">
                  {trader.avatar_url_mirror || trader.avatar_url ? (
                    <img
                      src={avatarSrc(trader.avatar_url_mirror || trader.avatar_url)}
                      alt=""
                      width={44}
                      height={44}
                      loading={rank <= 3 ? 'eager' : 'lazy'}
                      {...(rank === 1 ? { fetchPriority: 'high' as const } : {})}
                    />
                  ) : (
                    getInitial(trader.handle)
                  )}
                </span>
                <span className="ssr-trader-copy">
                  <span className="ssr-trader-name">{trader.handle}</span>
                  <span className="ssr-source-tag">{getSourceTypeLabel(trader.source_type)}</span>
                </span>
              </div>

              <div
                className="ssr-score-cell"
                aria-hidden="true"
                style={
                  scoreStyle
                    ? ({
                        '--ssr-score-bg': scoreStyle.bgGradient,
                        '--ssr-score-border': scoreStyle.borderColor,
                        '--ssr-score-color': scoreStyle.color,
                      } as CSSProperties)
                    : undefined
                }
              >
                <span className="ssr-score-badge">{score != null ? score.toFixed(0) : '—'}</span>
                {score != null && <ScoreMiniBar score={score} width={50} height={4} />}
              </div>

              <div className="ssr-roi-cell">
                <div className="ssr-roi-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, Math.abs(roi) / 20)}%`,
                      background:
                        roi >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
                    }}
                  />
                </div>
                <Metric value={trader.roi} format="roi" size="md" showArrow as="span" />
              </div>

              <div className="ssr-supporting-metrics">
                <div className="ssr-metric-cell ssr-pnl-cell">
                  <span className="ssr-mobile-metric-label">PnL</span>
                  <Metric value={trader.pnl} format="pnl" size="sm" showArrow as="span" />
                </div>

                <div className="ssr-metric-cell ssr-winrate-cell">
                  <span className="ssr-mobile-metric-label">Win%</span>
                  <span
                    className="ssr-metric-value"
                    style={{
                      color:
                        trader.win_rate != null && trader.win_rate > 50
                          ? 'var(--color-accent-success)'
                          : undefined,
                    }}
                  >
                    {winRate}
                  </span>
                </div>

                <div className="ssr-metric-cell ssr-mdd-cell">
                  <span className="ssr-mobile-metric-label">MDD</span>
                  <Metric
                    value={trader.max_drawdown != null ? -Math.abs(trader.max_drawdown) : null}
                    format="percent"
                    display={drawdownDisplay}
                    size="sm"
                    showArrow
                    as="span"
                  />
                </div>

                <div className="ssr-metric-cell ssr-sharpe-cell">
                  <span className="ssr-mobile-metric-label">Sharpe</span>
                  <span className="ssr-metric-value">
                    {trader.sharpe != null ? Number(trader.sharpe).toFixed(2) : '—'}
                  </span>
                </div>
              </div>
            </a>
          )
        })}
      </div>
    </section>
  )
}
