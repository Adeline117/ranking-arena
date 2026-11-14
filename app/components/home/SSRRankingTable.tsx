/**
 * SSRRankingTable — Server-rendered ranking shell.
 *
 * One row DOM serves both viewports: desktop gets the same grid information
 * architecture as RankingTable, while CSS reflows those cells into the
 * hydrated compact mobile rows (.mrow, MobileRankRows.tsx). Keeping a single link/value tree avoids
 * duplicate accessible content and the old mobile-card → desktop-table flash.
 */

import type { CSSProperties } from 'react'
import type { InitialTrader } from '@/lib/getInitialTraders'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getScoreColor } from '@/lib/utils/score-colors'
import { formatDrawdown } from '@/lib/utils/format'
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

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return <span className={`ssr-rank-medal ssr-rank-medal-${rank}`}>{rank}</span>
  }

  return <span className="ssr-rank-number">{rank}</span>
}

interface Props {
  traders: InitialTrader[]
}

export default async function SSRRankingTable({ traders }: Props) {
  // Keep the cacheable shell language-independent. The client tree localizes
  // after hydration, matching the rest of the homepage's static SSR strategy.
  const { t } = getStaticTranslation()
  if (!traders.length) {
    return (
      <div className="ssr-ranking-empty">
        <p>Loading rankings... / 加载排名中...</p>
        <p>Latest published ranking data will appear here / 最新已发布排行数据将在此显示</p>
      </div>
    )
  }

  return (
    <section className="ssr-ranking-table" aria-label={t('traderRankingsAria')}>
      {/* Reserves the client RankingFilters bar (category tabs + tools: 61px,
          +2px for the client container's border offset — measured) so the
          rows do not drop when the interactive table replaces this shell.
          Desktop only — critical CSS hides it below 768px. */}
      <div className="ssr-filter-bar" aria-hidden="true" />
      <div className="ssr-ranking-header ssr-ranking-grid" aria-hidden="true">
        <span>Rank</span>
        <span>Trader</span>
        <span>Score</span>
        <span>ROI (90D)</span>
        <span>PnL</span>
        <span>Win</span>
        <span>MDD</span>
      </div>
      {/* Mobile column header — same geometry as the client MobileRankHeader.
          The metric label follows html[data-rank-metric] like the rows. */}
      <div className="mrow-head" aria-hidden="true">
        <span>#</span>
        <span>Trader</span>
        <span className="mrow-head-score">Score</span>
        <span className="mrow-head-metric">
          <span className="mrow-head-metric-label">
            <span className="mrow-m mrow-m-roi">ROI</span>
            <span className="mrow-m mrow-m-pnl">PnL</span>
            <span className="mrow-m mrow-m-win">Win%</span>
            <span className="mrow-m mrow-m-mdd">MDD</span>
            <svg width={8} height={8} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 8h16l-8 10z" />
            </svg>
          </span>
        </span>
      </div>

      <div className="ssr-ranking-body mrow-list">
        {traders.map((trader) => {
          const rank = trader.rank
          const roi = trader.roi != null && Number.isFinite(trader.roi) ? trader.roi : null
          const score =
            trader.arena_score != null && Number.isFinite(Number(trader.arena_score))
              ? Number(trader.arena_score)
              : null
          const scoreColor = score != null ? getScoreColor(score) : null
          const winRate =
            trader.win_rate != null && Number.isFinite(trader.win_rate)
              ? `${Number(trader.win_rate).toFixed(1)}%`
              : trader.trades_count === 0
                ? t('holderBadge')
                : '—'
          const drawdownDisplay = formatDrawdown(trader.max_drawdown)
          const href = `/trader/${encodeURIComponent(trader.id)}?platform=${encodeURIComponent(trader.source)}`

          return (
            <a
              key={`${trader.source}-${trader.id}`}
              href={href}
              className={`ssr-ranking-entry ssr-ranking-grid mrow${rank <= 3 ? ` ssr-ranking-entry-rank-${rank} mrow-top mrow-top-${rank}` : ''}`}
              aria-label={t('rankingEntryAria')
                .replace('{rank}', String(rank))
                .replace('{name}', trader.handle)
                .replace(
                  '{score}',
                  score != null
                    ? t('arenaScoreAria').replace('{score}', score.toFixed(0))
                    : t('arenaScoreUnknownAria')
                )
                .replace(
                  '{roi}',
                  roi != null
                    ? t('roiValueAria').replace(
                        '{value}',
                        `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`
                      )
                    : t('roiUnknown')
                )}
            >
              <div className="ssr-rank-cell mrow-rank">
                <RankBadge rank={rank} />
              </div>

              <div className="ssr-trader-cell mrow-trader">
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
                <span className="ssr-trader-copy mrow-copy">
                  <span className="ssr-trader-name mrow-name">{trader.handle}</span>
                  <span className="ssr-source-tag mrow-tag">
                    {getSourceTypeLabel(trader.source_type)}
                  </span>
                </span>
              </div>

              {/* Score ring: 1px tier-colored border + neutral 18px number, no
                  fill (owner 2026-11-13) — mirrors ArenaScoreCircle. */}
              <div
                className="ssr-score-cell mrow-score-cell"
                aria-hidden="true"
                style={
                  scoreColor
                    ? ({
                        '--ssr-score-ring': scoreColor,
                        '--mrow-score-ring': scoreColor,
                      } as CSSProperties)
                    : undefined
                }
              >
                <span className="ssr-score-badge mrow-score">
                  {score != null ? score.toFixed(0) : '—'}
                </span>
                {score != null && (
                  <ScoreMiniBar
                    score={score}
                    width={50}
                    height={4}
                    ariaLabel={t('arenaScoreOfHundredAria').replace(
                      '{score}',
                      String(Math.round(score))
                    )}
                  />
                )}
              </div>

              <div className="ssr-roi-cell mrow-m mrow-m-roi">
                <Metric value={roi} format="roi" size="md" showArrow as="span" />
              </div>

              <div className="ssr-supporting-metrics">
                {/* PnL keeps gain/loss color; Win% and MDD are neutral
                    supporting stats (owner 2026-11-13). */}
                <div className="ssr-metric-cell ssr-pnl-cell mrow-m mrow-m-pnl">
                  <Metric value={trader.pnl} format="pnl" size="sm" showArrow as="span" />
                </div>

                <div className="ssr-metric-cell ssr-winrate-cell mrow-m mrow-m-win">
                  <span className="ssr-metric-value rank-stat">{winRate}</span>
                </div>

                <div className="ssr-metric-cell ssr-mdd-cell mrow-m mrow-m-mdd">
                  <span className="ssr-metric-value rank-stat">{drawdownDisplay}</span>
                </div>

                <div className="ssr-metric-cell ssr-sharpe-cell">
                  <span className="ssr-metric-value rank-stat">
                    {trader.sharpe != null && Number.isFinite(Number(trader.sharpe))
                      ? Number(trader.sharpe).toFixed(2)
                      : '—'}
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
