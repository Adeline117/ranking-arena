/**
 * SSRRankingTable - Pure Server Component
 * Renders the top traders as static HTML for instant LCP.
 * No JavaScript needed to display — painted by browser immediately.
 * The client-side RankingTable takes over after hydration.
 * 
 * Uses CSS classes instead of inline styles to minimize HTML size
 * (25 rows × repeated styles = significant savings).
 */

import type { InitialTrader } from '@/lib/getInitialTraders'

// Score color logic (server-side, no hooks)
function getScoreColor(score: number): string {
  if (score >= 90) return 'ssr-score-s'
  if (score >= 80) return 'ssr-score-a'
  if (score >= 70) return 'ssr-score-b'
  if (score >= 50) return 'ssr-score-c'
  return 'ssr-score-d'
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
.ssr-row-top{background:var(--color-accent-primary-06,rgba(139,92,246,0.06))}
.ssr-rank{font-size:13px;font-weight:800;text-align:center}
.ssr-rank-default{color:var(--color-text-tertiary)}
.ssr-info{display:flex;align-items:center;gap:10px;min-width:0}
.ssr-av{width:36px;height:36px;min-width:36px;border-radius:50%;background:linear-gradient(135deg,var(--color-accent-primary-30),var(--color-pro-gold-border,#a78bfa));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--color-on-accent,#fff);overflow:hidden;position:relative}
.ssr-av img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
.ssr-name{font-size:13px;font-weight:600;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssr-src{font-size:11px;color:var(--color-text-tertiary);text-transform:capitalize}
.ssr-score{text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.ssr-score-s{color:#22c55e}.ssr-score-a{color:#4ade80}.ssr-score-b{color:#a78bfa}.ssr-score-c{color:#94a3b8}.ssr-score-d{color:#64748b}
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

          return (
            <a
              key={`${trader.source}-${trader.id}`}
              href={`/trader/${encodeURIComponent(trader.id)}?platform=${trader.source}`}
              className={`ssr-row${isTop3 ? ' ssr-row-top' : ''}`}
            >
              <span className={`ssr-rank${isTop3 ? '' : ' ssr-rank-default'}`}
                style={isTop3 ? { color: RANK_COLORS[rank - 1] } : undefined}>
                {rank}
              </span>

              <div className="ssr-info">
                <div className="ssr-av">
                  {getInitial(trader.handle)}
                  {trader.avatar_url && (
                    <img
                      src={`/api/avatar?url=${encodeURIComponent(trader.avatar_url)}`}
                      alt={trader.handle || 'Trader avatar'}
                      width={36}
                      height={36}
                      loading={rank <= 3 ? 'eager' : 'lazy'}
                    />
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="ssr-name">{trader.handle}</div>
                  <div className="ssr-src">{trader.source_type}</div>
                </div>
              </div>

              <span className={`ssr-score ${getScoreColor(trader.arena_score)}`}>
                {trader.arena_score.toFixed(0)}
              </span>

              <div className="ssr-roi">
                <div className={`ssr-roi-val ${trader.roi >= 0 ? 'ssr-roi-pos' : 'ssr-roi-neg'}`}>
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
