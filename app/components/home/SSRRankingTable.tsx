/**
 * SSRRankingTable — Server-rendered mobile card layout.
 * Visually matches the React TraderCard component so the SSR→hydration
 * transition is invisible. Same card structure, same sizes, same colors.
 */

import type { ReactNode } from 'react'
import type { InitialTrader } from '@/lib/getInitialTraders'
import { formatPnL } from '@/lib/utils/format'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import { tokens } from '@/lib/design-tokens'
import Metric from '@/app/components/ui/Metric'
import ScoreMiniBar from '@/app/components/ranking/ScoreMiniBar'
import { getServerTranslation } from '@/lib/i18n/server'

/** Same tiers + CSS vars as the hydrated TraderCard (getScoreStyle in
 *  TraderDisplay wraps the same util) — the SSR shell previously used stale
 *  80/60/40 tiers with raw hexes, so chips visibly shifted on hydration. */
function getScoreStyle(score: number) {
  const info = getScoreColorInfo(score)
  return { bg: info.bgGradient, border: info.borderColor, color: info.color }
}

function getInitial(name: string): string {
  if (!name) return '?'
  const clean = name.startsWith('@') ? name.slice(1) : name
  if (clean.startsWith('0x')) return clean.charAt(2).toUpperCase()
  return clean.charAt(0).toUpperCase()
}

// Hydrated CSR (parseSourceInfo) renders all type tags in text-tertiary —
// the SSR shell's per-type amber/blue/violet flashed away on hydration.
const SOURCE_TYPE_COLOR = 'var(--color-text-tertiary)'

interface Props {
  traders: InitialTrader[]
  startRank?: number
}

export default async function SSRRankingTable({ traders, startRank = 0 }: Props) {
  const { t } = await getServerTranslation()
  if (!traders.length) {
    return (
      <div
        style={{
          padding: '48px 16px',
          textAlign: 'center',
          color: 'var(--color-text-tertiary)',
        }}
      >
        <p style={{ fontSize: tokens.typography.fontSize.md, marginBottom: 8 }}>
          Loading rankings... / 加载排名中...
        </p>
        <p style={{ fontSize: tokens.typography.fontSize.sm }}>
          Data refreshes every few minutes / 数据每几分钟刷新一次
        </p>
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
        const typeColor = SOURCE_TYPE_COLOR
        const typeLabel =
          trader.source_type === 'web3'
            ? 'On-chain'
            : trader.source_type === 'futures'
              ? 'Futures'
              : 'Spot'
        // Confirmed zero-trade wallet (trades_count === 0) reads "Holder", not a
        // dash — must match the hydrated TraderCard or the label flashes away.
        const winRate =
          trader.win_rate != null
            ? `${Number(trader.win_rate).toFixed(1)}%`
            : trader.trades_count === 0
              ? t('holderBadge')
              : '—'
        const sharpe = trader.sharpe != null ? Number(trader.sharpe).toFixed(2) : '—'
        const mdd =
          trader.max_drawdown != null
            ? Math.abs(trader.max_drawdown) < 0.05
              ? '< 0.1%'
              : `-${Math.abs(trader.max_drawdown).toFixed(1)}%`
            : '—'

        // PnL / MDD render through the shared Metric so they carry the same
        // colorblind-safe arrow cue (audit 1.2) as the hydrated TraderCard.
        const stats: { label: string; value: string; color?: string; node?: ReactNode }[] = [
          { label: 'Sharpe', value: sharpe },
          {
            label: 'PnL',
            value: formatPnL(trader.pnl),
            node:
              trader.pnl != null ? (
                <Metric value={trader.pnl} format="pnl" size="sm" as="span" showArrow />
              ) : undefined,
          },
          {
            label: 'Win%',
            value: winRate,
            color:
              trader.win_rate != null && trader.win_rate > 50
                ? 'var(--color-accent-success)'
                : undefined,
          },
          {
            label: 'MDD',
            value: mdd,
            node:
              trader.max_drawdown != null ? (
                <Metric
                  value={-Math.abs(trader.max_drawdown)}
                  format="percent"
                  display={
                    Math.abs(trader.max_drawdown) < 0.05
                      ? '< 0.1%'
                      : `-${Math.abs(trader.max_drawdown).toFixed(1)}%`
                  }
                  size="sm"
                  as="span"
                  showArrow
                />
              ) : undefined,
          },
        ]

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
              // Match TraderCard's card radius (tokens.radius.lg) — this SSR row is
              // the pre-hydration twin of TraderCard; a 12-vs-14 mismatch causes a
              // subtle radius pop on hydration.
              borderRadius: tokens.radius.lg,
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-primary)',
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
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.bold,
                      color: 'var(--color-bg-primary)',
                      background:
                        rank === 1
                          ? 'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))'
                          : rank === 2
                            ? 'linear-gradient(135deg, var(--color-medal-silver), var(--color-medal-silver-end))'
                            : 'linear-gradient(135deg, var(--color-medal-bronze), var(--color-medal-bronze-end))',
                    }}
                  >
                    {rank}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
                      fontWeight: 800,
                      color: 'var(--color-text-tertiary)',
                    }}
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
                    'linear-gradient(135deg, var(--color-accent-primary-30, rgba(139,111,168,0.3)), var(--color-pro-gold-border))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: tokens.typography.fontSize.md,
                  fontWeight: tokens.typography.fontWeight.bold,
                  color: 'var(--color-on-accent)',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                {trader.avatar_url_mirror || trader.avatar_url ? (
                  <img
                    src={avatarSrc(trader.avatar_url_mirror || trader.avatar_url)}
                    alt=""
                    width={44}
                    height={44}
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
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.bold,
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
                      borderRadius: tokens.radius.sm,
                      // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
                      fontSize: 11,
                      fontWeight: tokens.typography.fontWeight.bold,
                      lineHeight: 1.4,
                      color: typeColor,
                      background: `color-mix(in srgb, ${typeColor} 8%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${typeColor} 19%, transparent)`,
                    }}
                  >
                    {typeLabel}
                  </span>
                </div>
              </div>

              {/* Score badge + graded mini-bar (audit §4) */}
              {score && scoreStyle && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      minWidth: 50,
                      height: 28,
                      // Match TraderCard's score-badge radius (tokens.radius.md).
                      borderRadius: tokens.radius.md,
                      background: scoreStyle.bg,
                      border: `1px solid ${scoreStyle.border}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.black,
                      color: scoreStyle.color,
                    }}
                  >
                    {score}
                  </div>
                  {trader.arena_score != null && (
                    <ScoreMiniBar score={Number(trader.arena_score)} width={50} height={4} />
                  )}
                </div>
              )}
            </div>

            {/* Row 2: ROI bar + ROI value */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
                  borderRadius: 3,
                  background: roiPositive
                    ? `linear-gradient(90deg, var(--color-accent-success) ${Math.min(100, Math.abs(roiVal) / 20)}%, transparent)`
                    : `linear-gradient(90deg, var(--color-accent-error) ${Math.min(100, Math.abs(roiVal) / 20)}%, transparent)`,
                  opacity: 0.7,
                }}
              />
              <Metric
                value={trader.roi}
                format="roi"
                size="lg"
                showArrow
                style={{ marginLeft: 'auto' }}
              />
            </div>

            {/* Row 3: Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
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
                      // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      textTransform: 'uppercase',
                      fontWeight: tokens.typography.fontWeight.medium,
                      letterSpacing: '0.04em',
                      opacity: 0.7,
                    }}
                  >
                    {stat.label}
                  </span>
                  {stat.node ?? (
                    <span
                      style={{
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: tokens.typography.fontWeight.medium,
                        color: stat.color || 'var(--color-text-secondary)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {stat.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </a>
        )
      })}
    </div>
  )
}
