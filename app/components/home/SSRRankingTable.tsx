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
    <>
      <style dangerouslySetInnerHTML={{ __html: `
.ssr-t{background:var(--color-bg-secondary);border-radius:16px;border:1px solid var(--color-border-primary);overflow:hidden}
.ssr-hdr{display:grid;grid-template-columns:40px 1fr 60px 80px 60px 60px;padding:10px 16px;font-size:10px;font-weight:700;color:var(--color-text-quaternary,var(--color-text-tertiary));border-bottom:1px solid var(--color-border-primary);gap:8px;text-transform:uppercase;letter-spacing:0.05em;position:sticky;top:0;z-index:10;background:var(--color-bg-secondary);backdrop-filter:blur(12px)}
.ssr-row{display:grid;grid-template-columns:40px 1fr 60px 80px 60px 60px;padding:10px 16px;gap:8px;align-items:center;text-decoration:none;color:inherit;border-bottom:1px solid var(--color-border-primary);min-height:52px;transition:background 0.18s ease,transform 0.18s ease}
.ssr-row:hover{background:var(--color-bg-hover,#252232);transform:translateY(-1px)}
.ssr-row:focus-visible{outline:2px solid var(--color-brand);outline-offset:-2px;border-radius:4px}
.ssr-row:active{transform:scale(0.998)}
.ssr-row-gold{background:linear-gradient(135deg,rgba(255,215,0,0.10) 0%,rgba(255,215,0,0.03) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-gold,#FFD700)}.ssr-row-silver{background:linear-gradient(135deg,rgba(192,192,192,0.08) 0%,rgba(192,192,192,0.02) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-silver,#C0C0C0)}.ssr-row-bronze{background:linear-gradient(135deg,rgba(205,127,50,0.08) 0%,rgba(205,127,50,0.02) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-bronze,#CD7F32)}
.ssr-rank{font-size:13px;font-weight:800;text-align:center;display:flex;align-items:center;justify-content:center}
.ssr-rank-default{color:var(--color-text-tertiary)}
.ssr-rank-circle{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--color-bg-primary,#0B0A10)}
.ssr-info{display:flex;align-items:center;gap:10px;min-width:0}
.ssr-av{width:36px;height:36px;min-width:36px;aspect-ratio:1;border-radius:50%;background:linear-gradient(135deg,var(--color-accent-primary-30),var(--color-pro-gold-border,#a78bfa));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--color-on-accent,#fff);overflow:hidden;position:relative;contain:layout style paint}
.ssr-av img{width:100%;height:100%;object-fit:cover;border-radius:50%;position:absolute;inset:0}
.ssr-name{font-size:13px;font-weight:600;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssr-src{font-size:11px;color:var(--color-text-tertiary);text-transform:capitalize}
.ssr-score{text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.ssr-score-s{color:var(--color-accent-success,#22c55e)}.ssr-score-a{color:var(--color-score-a,#4ade80)}.ssr-score-b{color:var(--color-accent-primary,#a78bfa)}.ssr-score-c{color:var(--color-text-secondary,#94a3b8)}.ssr-score-d{color:var(--color-text-tertiary,#64748b)}
.ssr-roi{text-align:right;font-variant-numeric:tabular-nums}
.ssr-roi-val{font-size:13px;font-weight:600}
.ssr-roi-pos{color:var(--color-success)}.ssr-roi-neg{color:var(--color-danger)}
.ssr-pnl{font-size:10px;color:var(--color-text-tertiary)}
.ssr-wr{text-align:right;font-size:12px;color:var(--color-text-secondary);font-variant-numeric:tabular-nums}
.ssr-mdd{text-align:right;font-size:12px;color:var(--color-danger);font-variant-numeric:tabular-nums}
.ssr-r{text-align:right}
` }} />
      <div id="ssr-ranking-table" className="ssr-t">
        <div className="ssr-hdr">
          <span>RANK</span>
          <span>TRADER</span>
          <span className="ssr-r">SCORE</span>
          <span className="ssr-r">ROI</span>
          <span className="hide-mobile ssr-r">WIN%</span>
          <span className="hide-mobile ssr-r">MDD</span>
        </div>

        {traders.slice(0, 25).map((trader, idx) => {
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
    </>
  )
}
