'use client'

import { localizedLabel, NULL_DISPLAY } from '@/lib/utils/format'
/**
 * Bot Detail Page - /bot/[id]
 * Shows performance, stats, and on-chain info for a specific bot.
 *
 * NOTE on missing data (do not fabricate):
 *  - The bot detail payload exposes no per-day time-series (`equity_curve` is
 *    always []), so a return/equity curve is intentionally NOT rendered.
 *  - Neither the bot row nor its snapshots carry a leaderboard rank/percentile,
 *    so no rank context is shown. The Arena Score grade tier is the only honest
 *    hierarchy signal available and is derived from the score itself.
 */

import { use, useState } from 'react'
import Link from 'next/link'
import { Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useBotDetail } from '@/lib/hooks/useBotRankings'
// MobileBottomNav is rendered by root layout — do not duplicate here
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { Box } from '@/app/components/base'
import Metric, { type MetricFormat } from '@/app/components/ui/Metric'
import { getScoreColor, scoreColorAlpha, getScoreColorInfo } from '@/lib/utils/score-colors'

function formatLargeNumber(n: number | null): string {
  if (n == null) return NULL_DISPLAY
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function formatUsers(n: number | null): string {
  if (n == null) return NULL_DISPLAY
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

/** Card chrome shared by unsigned StatCard + signed MetricStatCard. */
const cardChrome: React.CSSProperties = {
  padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
  borderRadius: tokens.radius.lg,
  background: 'var(--glass-bg-light)',
  border: `1px solid var(--color-border-primary)`,
}

const cardSubStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: 'var(--color-text-tertiary)',
  marginTop: tokens.spacing[1],
}

interface StatCardProps {
  label: string
  value: string
  sub?: string
  color?: string
}

/** Unsigned figure (TVL, users, volume…) — neutral, no sign color. */
function StatCard({ label, value, sub, color }: StatCardProps) {
  return (
    <div style={cardChrome}>
      <div
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          marginBottom: tokens.spacing[1],
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: tokens.typography.fontSize.xl,
          fontWeight: tokens.typography.fontWeight.bold,
          color: color || 'var(--color-text-primary)',
          fontFamily: tokens.typography.fontFamily.mono.join(','),
        }}
      >
        {value}
      </div>
      {sub && <div style={cardSubStyle}>{sub}</div>}
    </div>
  )
}

/**
 * Signed figure (APY, ROI, max drawdown) routed through <Metric showArrow> so
 * gain/loss is conveyed by a ▲/▼ glyph + the +/− sign, not color alone
 * (colorblind-safe). Color is retained as reinforcement.
 */
function MetricStatCard({
  label,
  value,
  format,
  sub,
}: {
  label: string
  value: number | null
  format: MetricFormat
  sub?: string
}) {
  return (
    <div style={cardChrome}>
      <Metric label={label} value={value} format={format} showArrow size="lg" />
      {sub && <div style={cardSubStyle}>{sub}</div>}
    </div>
  )
}

const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  tg_bot: { zh: 'Telegram 交易Bot', en: 'Telegram Trading Bot' },
  ai_agent: { zh: 'AI 交易代理', en: 'AI Trading Agent' },
  vault: { zh: '链上金库', en: 'On-chain Vault' },
  strategy: { zh: '量化策略', en: 'Trading Strategy' },
}

type SortKey = 'total_volume' | 'apy' | 'roi' | 'arena_score'

/** Read a numeric snapshot field for sorting; null/undefined sink to the bottom. */
function snapNum(s: Record<string, unknown>, key: SortKey): number {
  const v = s[key]
  return v == null ? Number.NEGATIVE_INFINITY : Number(v)
}

function BotDetailContent({ id }: { id: string }) {
  const { language, t } = useLanguage()
  const { data, error, isLoading } = useBotDetail(id)
  const [copied, setCopied] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  if (isLoading) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: 'var(--color-bg-primary)',
          color: 'var(--color-text-primary)',
        }}
      >
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div
            style={{
              height: 300,
              borderRadius: tokens.radius.lg,
              background: 'var(--glass-bg-light)',
              animation: 'pulse 2s infinite',
            }}
          />
        </div>
      </Box>
    )
  }

  if (error || !data?.bot) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: 'var(--color-bg-primary)',
          color: 'var(--color-text-primary)',
        }}
      >
        <div className="max-w-4xl mx-auto px-4 py-20 text-center">
          <h2 style={{ fontSize: tokens.typography.fontSize.xl }}>{t('botNotFound')}</h2>
          <Link
            href="/rankings/bots"
            style={{ color: 'var(--color-accent-brand)', marginTop: 16, display: 'inline-block' }}
          >
            {t('botBackToRankings')}
          </Link>
        </div>
      </Box>
    )
  }

  const bot = data.bot
  const snapshots: Record<string, unknown>[] = data.snapshots || []
  // Use 90D snapshot as primary
  const snap = snapshots.find((s) => s.season_id === '90D') || snapshots[0]
  const catLabel = CATEGORY_LABELS[bot.category] || { zh: bot.category, en: bot.category }

  const locale =
    // eslint-disable-next-line no-restricted-syntax -- Intl date-locale mapping, not user-facing copy
    language === 'zh'
      ? 'zh-CN'
      : language === 'ja'
        ? 'ja-JP'
        : language === 'ko'
          ? 'ko-KR'
          : 'en-US'

  // Data-freshness "as of" — derived from the primary snapshot's capture time.
  const capturedAt = (snap?.captured_at as string | undefined) || (data.as_of as string | undefined)
  const asOf = capturedAt
    ? new Date(capturedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : null

  // Primary CTA target: prefer the bot's own product surface, then Telegram.
  const ctaHref = bot.website_url || bot.telegram_url || null

  const handleShare = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : ''
    if (!url) return
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: bot.name, url })
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // User dismissed the share sheet, or share/clipboard unavailable — no-op.
    }
  }

  const scoreVal = snap?.arena_score != null ? Number(snap.arena_score) : null
  const scoreInfo = scoreVal != null ? getScoreColorInfo(scoreVal) : null

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedSnapshots = sortKey
    ? [...snapshots].sort((a, b) => {
        const av = snapNum(a, sortKey)
        const bv = snapNum(b, sortKey)
        return sortDir === 'asc' ? av - bv : bv - av
      })
    : snapshots

  const ariaSortFor = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'

  const thStyle: React.CSSProperties = {
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: tokens.typography.fontWeight.semibold,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    borderBottom: `1px solid var(--color-border-primary)`,
    whiteSpace: 'nowrap',
  }
  const tdStyle: React.CSSProperties = {
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    fontSize: tokens.typography.fontSize.sm,
    borderBottom: `1px solid var(--color-border-primary)`,
  }

  // Sortable column header — a render helper (not a component) so it shares the
  // closure's sort state without remounting. A <button> makes it keyboard-
  // operable; aria-sort lives on the <th>.
  const renderSortHeader = (label: string, sortKeyName: SortKey) => {
    const active = sortKey === sortKeyName
    const arrow = !active ? '' : sortDir === 'asc' ? ' ▲' : ' ▼'
    return (
      <th
        key={sortKeyName}
        style={{ ...thStyle, textAlign: 'right' }}
        aria-sort={ariaSortFor(sortKeyName)}
        scope="col"
      >
        <button
          type="button"
          onClick={() => handleSort(sortKeyName)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: active ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
            font: 'inherit',
            textTransform: 'inherit',
            padding: 0,
          }}
        >
          {label}
          <span aria-hidden="true">{arrow}</span>
        </button>
      </th>
    )
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      <div className="max-w-4xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        {/* Breadcrumb */}
        <Link
          href="/rankings/bots"
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-accent-brand)',
            textDecoration: 'none',
            display: 'inline-block',
            marginBottom: tokens.spacing[4],
          }}
        >
          {t('botBreadcrumb')}
        </Link>

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div
            style={{
              width: 56,
              height: 56,
              minWidth: 56,
              borderRadius: tokens.radius.xl,
              background:
                bot.category === 'tg_bot'
                  ? 'linear-gradient(135deg, var(--color-chart-amber), var(--color-chart-orange))'
                  : bot.category === 'ai_agent'
                    ? 'linear-gradient(135deg, var(--color-chart-violet), var(--color-chart-indigo))'
                    : 'linear-gradient(135deg, var(--color-chart-teal), var(--color-chart-blue))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-on-accent)',
              // eslint-disable-next-line no-restricted-syntax -- off-scale avatar initial by design
              fontSize: 22,
              fontWeight: tokens.typography.fontWeight.bold,
            }}
          >
            {bot.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h1
              style={{
                fontSize: tokens.typography.fontSize['2xl'],
                fontWeight: tokens.typography.fontWeight.extrabold,
                lineHeight: 1.2,
              }}
            >
              {bot.name}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: tokens.radius.sm,
                  // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                  fontSize: 11,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  background: 'var(--color-accent-brand-bg)',
                  color: 'var(--color-accent-brand)',
                }}
              >
                {localizedLabel(catLabel.zh, catLabel.en, language)}
              </span>
              {bot.chain && (
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: tokens.radius.sm,
                    // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                    fontSize: 11,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    background: 'var(--glass-bg-light)',
                    color: 'var(--color-text-secondary)',
                    textTransform: 'capitalize',
                  }}
                >
                  {bot.chain}
                </span>
              )}
              {bot.token_symbol && (
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: 'var(--color-text-tertiary)',
                    fontWeight: tokens.typography.fontWeight.medium,
                  }}
                >
                  ${bot.token_symbol}
                </span>
              )}
            </div>
            {bot.description && (
              <p
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: 'var(--color-text-secondary)',
                  marginTop: 8,
                  lineHeight: 1.5,
                }}
              >
                {bot.description}
              </p>
            )}
          </div>

          {/* Arena Score — promoted hero metric: large value + grade tier + explainer. */}
          {scoreVal != null && scoreInfo && (
            <div
              style={{
                textAlign: 'center',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                background: scoreInfo.bgGradient,
                border: `1px solid ${scoreInfo.borderColor}`,
                minWidth: 120,
              }}
            >
              <div
                style={{
                  // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: tokens.spacing[1],
                  textTransform: 'uppercase',
                }}
              >
                {t('botArenaScore')}
              </div>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.hero,
                  fontWeight: tokens.typography.fontWeight.extrabold,
                  fontFamily: tokens.typography.fontFamily.mono.join(','),
                  color: getScoreColor(scoreVal),
                  textShadow: scoreVal >= 80 ? `0 0 12px ${scoreColorAlpha(scoreVal, 25)}` : 'none',
                  lineHeight: 1.1,
                }}
              >
                {scoreVal.toFixed(1)}
              </div>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: scoreInfo.color,
                  marginTop: tokens.spacing[1],
                }}
              >
                {t(`botGrade_${scoreInfo.grade}`)}
              </div>
              <Link
                href="/methodology"
                style={{
                  display: 'inline-block',
                  marginTop: tokens.spacing[1],
                  // eslint-disable-next-line no-restricted-syntax -- off-scale micro link by design
                  fontSize: 11,
                  color: 'var(--color-accent-brand)',
                  textDecoration: 'none',
                }}
              >
                {t('botWhatIsArenaScore')}
              </Link>
            </div>
          )}
        </div>

        {/* Primary actions: use/trade CTA + share */}
        <div className="flex flex-wrap gap-3 mb-4">
          {ctaHref && (
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                background: 'var(--color-accent-brand)',
                color: 'var(--color-on-accent)',
                textDecoration: 'none',
              }}
            >
              {t('botUseCta')}
            </a>
          )}
          <button
            type="button"
            onClick={handleShare}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              background: 'var(--glass-bg-light)',
              border: `1px solid var(--color-border-primary)`,
              color: 'var(--color-text-primary)',
              cursor: 'pointer',
            }}
          >
            {copied ? t('botShareCopied') : t('botShare')}
          </button>
        </div>

        {/* Trust / disclosure strip: freshness + risk disclosure + score explainer */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            background: 'var(--glass-bg-light)',
            border: `1px solid var(--color-border-primary)`,
            marginBottom: tokens.spacing[6],
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-text-tertiary)',
            lineHeight: 1.5,
          }}
        >
          {asOf && (
            <span style={{ color: 'var(--color-text-secondary)' }}>
              {t('botDataAsOf').replace('{date}', asOf)}
            </span>
          )}
          <span>{t('botDisclosure')}</span>
          <Link
            href="/methodology"
            style={{ color: 'var(--color-accent-brand)', textDecoration: 'none' }}
          >
            {t('botWhatIsArenaScore')}
          </Link>
        </div>

        {/* External links (secondary) */}
        {(bot.website_url || bot.twitter_handle || bot.telegram_url) && (
          <div className="flex flex-wrap gap-3 mb-6">
            {bot.website_url && (
              <a
                href={bot.website_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '6px 14px',
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.medium,
                  background: 'var(--glass-bg-light)',
                  border: `1px solid var(--color-border-primary)`,
                  color: 'var(--color-text-primary)',
                  textDecoration: 'none',
                }}
              >
                {t('botWebsite')}
              </a>
            )}
            {bot.twitter_handle && (
              <a
                href={`https://x.com/${bot.twitter_handle}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '6px 14px',
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.medium,
                  background: 'var(--glass-bg-light)',
                  border: `1px solid var(--color-border-primary)`,
                  color: 'var(--color-text-primary)',
                  textDecoration: 'none',
                }}
              >
                Twitter/X
              </a>
            )}
            {bot.telegram_url && (
              <a
                href={bot.telegram_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '6px 14px',
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.medium,
                  background: 'var(--glass-bg-light)',
                  border: `1px solid var(--color-border-primary)`,
                  color: 'var(--color-text-primary)',
                  textDecoration: 'none',
                }}
              >
                Telegram
              </a>
            )}
          </div>
        )}

        {/* Stats grid */}
        {snap && (
          <>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.bold,
                marginBottom: tokens.spacing[3],
              }}
            >
              {t('botKeyMetrics90D')}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <StatCard label="TVL" value={formatLargeNumber(snap.tvl as number | null)} />
              <StatCard
                label={t('botUsers')}
                value={formatUsers(snap.unique_users as number | null)}
              />
              {/* APY and ROI split into clearly separate, labeled figures. */}
              <MetricStatCard label={t('botApy')} value={snap.apy as number | null} format="roi" />
              {snap.roi != null && (
                <MetricStatCard
                  label={t('botRoi')}
                  value={snap.roi as number | null}
                  format="roi"
                />
              )}
              <StatCard
                label={t('botVolume')}
                value={formatLargeNumber(snap.total_volume as number | null)}
              />
              <StatCard
                label={t('botRevenue')}
                value={formatLargeNumber(snap.revenue as number | null)}
              />
              {/* Max drawdown as a signed (negative) figure + a definitional hint
                  for context. True time-to-recover isn't in the payload, so it's
                  not claimed. */}
              <MetricStatCard
                label={t('botMaxDrawdown')}
                value={snap.max_drawdown != null ? -Number(snap.max_drawdown) : null}
                format="roi"
                sub={t('botMaxDrawdownHint')}
              />
              {snap.token_price != null && (
                <StatCard
                  label={t('botTokenPrice')}
                  value={`$${Number(snap.token_price).toFixed(4)}`}
                />
              )}
              {snap.market_cap != null && (
                <StatCard
                  label={t('botMarketCap')}
                  value={formatLargeNumber(snap.market_cap as number | null)}
                />
              )}
            </div>
          </>
        )}

        {/* Multi-window comparison — real table semantics + sortable columns. */}
        {snapshots.length > 1 && (
          <>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.bold,
                marginBottom: tokens.spacing[3],
              }}
            >
              {t('botWindowComparison')}
            </h2>
            <div
              className="rounded-xl mb-8"
              style={{
                background: 'var(--glass-bg-secondary)',
                border: `1px solid var(--color-border-primary)`,
                overflowX: 'auto',
              }}
            >
              <table
                style={{
                  width: '100%',
                  minWidth: 440,
                  borderCollapse: 'collapse',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <caption className="sr-only">{t('botWindowComparison')}</caption>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, textAlign: 'left' }} scope="col">
                      {t('botWindow')}
                    </th>
                    {renderSortHeader(t('botVolume'), 'total_volume')}
                    {renderSortHeader(t('botApy'), 'apy')}
                    {renderSortHeader(t('botRoi'), 'roi')}
                    {renderSortHeader(t('botScore'), 'arena_score')}
                  </tr>
                </thead>
                <tbody>
                  {sortedSnapshots.map((s) => (
                    <tr key={s.season_id as string}>
                      <td
                        style={{
                          ...tdStyle,
                          fontWeight: tokens.typography.fontWeight.semibold,
                        }}
                      >
                        {s.season_id as string}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        {formatLargeNumber(s.total_volume as number | null)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <Metric
                          value={s.apy as number | null}
                          format="roi"
                          size="sm"
                          align="right"
                          showArrow
                          as="span"
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <Metric
                          value={s.roi as number | null}
                          format="roi"
                          size="sm"
                          align="right"
                          showArrow
                          as="span"
                        />
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          fontWeight: tokens.typography.fontWeight.bold,
                          fontFamily: tokens.typography.fontFamily.mono.join(','),
                          color:
                            s.arena_score != null
                              ? getScoreColor(Number(s.arena_score))
                              : 'var(--color-text-tertiary)',
                        }}
                      >
                        {s.arena_score != null ? Number(s.arena_score).toFixed(1) : NULL_DISPLAY}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* On-chain info */}
        {(bot.contract_address || bot.token_address) && (
          <>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.bold,
                marginBottom: tokens.spacing[3],
              }}
            >
              {t('botOnChainInfo')}
            </h2>
            <div
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                background: 'var(--glass-bg-light)',
                border: `1px solid var(--color-border-primary)`,
                marginBottom: tokens.spacing[6],
              }}
            >
              {bot.contract_address && (
                <div style={{ marginBottom: 8 }}>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {t('botContractAddress')}
                  </span>
                  <code
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: 'var(--color-text-secondary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {bot.contract_address}
                  </code>
                </div>
              )}
              {bot.token_address && (
                <div>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {t('botTokenAddress')}
                  </span>
                  <code
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: 'var(--color-text-secondary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {bot.token_address}
                  </code>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}

export default function BotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <ErrorBoundary pageType="general">
      <Suspense
        fallback={
          <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
            <div className="max-w-4xl mx-auto px-4 py-6">
              <div
                style={{
                  height: 300,
                  borderRadius: tokens.radius.lg,
                  background: 'var(--glass-bg-light)',
                }}
              />
            </div>
          </Box>
        }
      >
        <BotDetailContent id={id} />
      </Suspense>
    </ErrorBoundary>
  )
}
