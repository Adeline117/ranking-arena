/**
 * SSRRankingTable - Optimized Version
 * Performance improvements:
 * 1. Use next/image for optimized image loading (AVIF/WebP)
 * 2. Direct CDN URLs instead of /api/avatar proxy
 * 3. Priority loading for top 3 traders
 * 4. Better CLS prevention with explicit dimensions
 */

import type { InitialTrader } from '@/lib/getInitialTraders'
import Image from 'next/image'
import { isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { formatROI, formatPnL } from '@/lib/utils/format'

// Score color logic (server-side, no hooks)
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
}

const RANK_COLORS = ['var(--color-rank-gold, #FFD700)', 'var(--color-rank-silver, #C0C0C0)', 'var(--color-rank-bronze, #CD7F32)']

export default function SSRRankingTable({ traders }: Props) {
  if (!traders.length) return null

  return (
      <div id="ssr-ranking-table" className="ssr-t">
        <div className="ssr-hdr">
          <span>RANK</span>
          <span>TRADER</span>
          <span className="ssr-r">SCORE</span>
          <span className="ssr-r">ROI</span>
          <span className="hide-mobile ssr-r">WIN%</span>
          <span className="hide-mobile ssr-r">MDD</span>
        </div>

        {traders.slice(0, 10).map((trader, idx) => {
          const rank = idx + 1
          const isTop3 = rank <= 3
          // SSR: always use direct CDN URLs — no CORS issue for server-rendered <img>
          // The /api/avatar proxy is only needed for client-side fetch() where CORS applies
          const avatarUrl = trader.avatar_url && !trader.avatar_url.startsWith('/')
            ? trader.avatar_url
            : trader.avatar_url
              ? `/api/avatar?url=${encodeURIComponent(trader.avatar_url)}`
              : null

          return (
            <a
              key={`${trader.source}-${trader.id}`}
              href={`/trader/${encodeURIComponent(trader.id)}?platform=${trader.source}`}
              className={`ssr-row${rank === 1 ? ' ssr-row-gold' : rank === 2 ? ' ssr-row-silver' : rank === 3 ? ' ssr-row-bronze' : ''}`}
            >
              <span className={`ssr-rank${isTop3 ? '' : ' ssr-rank-default'}`}>
                {isTop3 ? (
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

              <div className="ssr-info">
                <div className="ssr-av">
                  {getInitial(trader.handle)}
                  {avatarUrl ? (
                    <Image
                      src={avatarUrl}
                      alt={trader.handle || 'Trader'}
                      width={36}
                      height={36}
                      priority={isTop3}
                      loading={isTop3 ? undefined : 'lazy'}
                      sizes="36px"
                      style={{ borderRadius: '50%' }}
                    />
                  ) : isWalletAddress(trader.id) ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={generateBlockieSvg(trader.id, 72)}
                      alt={trader.handle || 'Trader'}
                      width={36}
                      height={36}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', position: 'absolute', inset: 0, imageRendering: 'pixelated' }}
                    />
                  ) : null}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="ssr-name">{trader.handle}</div>
                  <div className="ssr-src">{trader.source_type}</div>
                </div>
              </div>

              <span className={`ssr-score ${trader.arena_score != null ? getScoreColor(trader.arena_score) : ''}`}>
                {trader.arena_score != null ? trader.arena_score.toFixed(0) : '—'}
              </span>

              <div className="ssr-roi">
                <div className={`ssr-roi-val ${(trader.roi ?? 0) >= 0 ? 'ssr-roi-pos' : 'ssr-roi-neg'}`}>
                  {formatROI(trader.roi)}
                </div>
                <div className="ssr-pnl">{formatPnL(trader.pnl)}</div>
              </div>

              <span className="hide-mobile ssr-wr">
                {trader.win_rate != null ? `${trader.win_rate.toFixed(1)}%` : '—'}
              </span>

              <span className="hide-mobile ssr-mdd">
                {trader.max_drawdown != null ? (Math.abs(trader.max_drawdown) < 0.05 ? '< 0.1%' : `-${Math.abs(trader.max_drawdown).toFixed(1)}%`) : '—'}
              </span>
            </a>
          )
        })}
      </div>
  )
}
