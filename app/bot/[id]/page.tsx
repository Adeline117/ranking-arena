'use client'

import { localizedLabel } from '@/lib/utils/format'
/**
 * Bot Detail Page - /bot/[id]
 * Shows performance, stats, and on-chain info for a specific bot.
 */

import { use } from 'react'
import Link from 'next/link'
import { Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useBotDetail } from '@/lib/hooks/useBotRankings'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { Box } from '@/app/components/base'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'

function formatLargeNumber(n: number | null): string {
  if (n == null) return '--'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function formatUsers(n: number | null): string {
  if (n == null) return '--'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

function formatPercent(n: number | null): string {
  if (n == null) return '--'
  return `${n.toFixed(2)}%`
}

interface StatCardProps {
  label: string
  value: string
  sub?: string
  color?: string
}

function StatCard({ label, value, sub, color }: StatCardProps) {
  return (
    <div style={{
      padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
      borderRadius: tokens.radius.lg,
      background: 'var(--glass-bg-light, rgba(255,255,255,0.04))',
      border: `1px solid var(--color-border-primary)`,
    }}>
      <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ fontSize: tokens.typography.fontSize.xl, fontWeight: 700, color: color || 'var(--color-text-primary)', fontFamily: tokens.typography.fontFamily.mono.join(',') }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  tg_bot: { zh: 'Telegram 交易Bot', en: 'Telegram Trading Bot' },
  ai_agent: { zh: 'AI 交易代理', en: 'AI Trading Agent' },
  vault: { zh: '链上金库', en: 'On-chain Vault' },
  strategy: { zh: '量化策略', en: 'Trading Strategy' },
}

function BotDetailContent({ id }: { id: string }) {
  const { language, t } = useLanguage()
  const { data, error, isLoading } = useBotDetail(id)

  if (isLoading) {
    return (
      <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
        <TopNav email={null} />
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div style={{ height: 300, borderRadius: tokens.radius.lg, background: 'var(--glass-bg-light)', animation: 'pulse 2s infinite' }} />
        </div>
      </Box>
    )
  }

  if (error || !data?.bot) {
    return (
      <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
        <TopNav email={null} />
        <div className="max-w-4xl mx-auto px-4 py-20 text-center">
          <h2 style={{ fontSize: tokens.typography.fontSize.xl }}>{t('botNotFound')}</h2>
          <Link href="/rankings/bots" style={{ color: 'var(--color-accent-brand)', marginTop: 16, display: 'inline-block' }}>
            {t('botBackToRankings')}
          </Link>
        </div>
      </Box>
    )
  }

  const bot = data.bot
  const snapshots = data.snapshots || []
  // Use 90D snapshot as primary
  const snap = snapshots.find((s: Record<string, unknown>) => s.season_id === '90D') || snapshots[0]
  const catLabel = CATEGORY_LABELS[bot.category] || { zh: bot.category, en: bot.category }

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
      <TopNav email={null} />
      <div className="max-w-4xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        {/* Breadcrumb */}
        <Link
          href="/rankings/bots"
          style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-accent-brand)', textDecoration: 'none', display: 'inline-block', marginBottom: tokens.spacing[4] }}
        >
          {t('botBreadcrumb')}
        </Link>

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div style={{
            width: 56, height: 56, minWidth: 56, borderRadius: tokens.radius.xl,
            background: bot.category === 'tg_bot'
              ? 'linear-gradient(135deg, var(--color-chart-amber), var(--color-chart-orange))'
              : bot.category === 'ai_agent'
              ? 'linear-gradient(135deg, var(--color-chart-violet), var(--color-chart-indigo))'
              : 'linear-gradient(135deg, var(--color-chart-teal), var(--color-chart-blue))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--color-on-accent)', fontSize: 22, fontWeight: 700,
          }}>
            {bot.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 800, lineHeight: 1.2 }}>{bot.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span style={{
                padding: '2px 8px', borderRadius: tokens.radius.sm, fontSize: 11, fontWeight: 600,
                background: 'var(--color-accent-brand-bg, rgba(99,102,241,0.15))',
                color: 'var(--color-accent-brand)',
              }}>
                {localizedLabel(catLabel.zh, catLabel.en, language)}
              </span>
              {bot.chain && (
                <span style={{
                  padding: '2px 8px', borderRadius: tokens.radius.sm, fontSize: 11, fontWeight: 600,
                  background: 'var(--glass-bg-light)',
                  color: 'var(--color-text-secondary)', textTransform: 'capitalize',
                }}>
                  {bot.chain}
                </span>
              )}
              {bot.token_symbol && (
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
                  ${bot.token_symbol}
                </span>
              )}
            </div>
            {bot.description && (
              <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
                {bot.description}
              </p>
            )}
          </div>
          {/* Arena Score */}
          {snap?.arena_score != null && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4, textTransform: 'uppercase' }}>Arena Score</div>
              <div style={{
                fontSize: 28, fontWeight: 800,
                fontFamily: tokens.typography.fontFamily.mono.join(','),
                color: getScoreColor(snap.arena_score),
                textShadow: snap.arena_score >= 80 ? `0 0 12px ${getScoreColorHex(snap.arena_score)}40` : 'none',
              }}>
                {Number(snap.arena_score).toFixed(1)}
              </div>
            </div>
          )}
        </div>

        {/* Links */}
        <div className="flex gap-3 mb-6">
          {bot.website_url && (
            <a href={bot.website_url} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '6px 14px', borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.sm, fontWeight: 500,
                background: 'var(--glass-bg-light)', border: `1px solid var(--color-border-primary)`,
                color: 'var(--color-text-primary)', textDecoration: 'none',
              }}>
              {t('botWebsite')}
            </a>
          )}
          {bot.twitter_handle && (
            <a href={`https://x.com/${bot.twitter_handle}`} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '6px 14px', borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.sm, fontWeight: 500,
                background: 'var(--glass-bg-light)', border: `1px solid var(--color-border-primary)`,
                color: 'var(--color-text-primary)', textDecoration: 'none',
              }}>
              Twitter/X
            </a>
          )}
          {bot.telegram_url && (
            <a href={bot.telegram_url} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '6px 14px', borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.sm, fontWeight: 500,
                background: 'var(--glass-bg-light)', border: `1px solid var(--color-border-primary)`,
                color: 'var(--color-text-primary)', textDecoration: 'none',
              }}>
              Telegram
            </a>
          )}
        </div>

        {/* Stats grid */}
        {snap && (
          <>
            <h2 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 700, marginBottom: tokens.spacing[3] }}>
              {t('botKeyMetrics90D')}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <StatCard label="TVL" value={formatLargeNumber(snap.tvl)} />
              <StatCard label={t('botUsers')} value={formatUsers(snap.unique_users)} />
              <StatCard
                label="APY"
                value={formatPercent(snap.apy)}
                color={snap.apy != null && snap.apy > 0 ? 'var(--color-accent-success)' : undefined}
              />
              <StatCard label={t('botVolume')} value={formatLargeNumber(snap.total_volume)} />
              <StatCard label={t('botRevenue')} value={formatLargeNumber(snap.revenue)} />
              <StatCard
                label={t('botMaxDrawdown')}
                value={snap.max_drawdown != null ? `-${Number(snap.max_drawdown).toFixed(1)}%` : '—'}
                color={snap.max_drawdown != null ? 'var(--color-accent-error)' : undefined}
              />
              {snap.token_price != null && (
                <StatCard
                  label={t('botTokenPrice')}
                  value={`$${Number(snap.token_price).toFixed(4)}`}
                />
              )}
              {snap.market_cap != null && (
                <StatCard label={t('botMarketCap')} value={formatLargeNumber(snap.market_cap)} />
              )}
            </div>
          </>
        )}

        {/* Multi-window comparison */}
        {snapshots.length > 1 && (
          <>
            <h2 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 700, marginBottom: tokens.spacing[3] }}>
              {t('botWindowComparison')}
            </h2>
            <div className="rounded-xl overflow-hidden mb-8" style={{
              background: 'var(--glass-bg-secondary, rgba(255,255,255,0.03))',
              border: `1px solid var(--color-border-primary)`,
            }}>
              <div className="grid grid-cols-4 gap-2 px-4 py-3 text-xs font-semibold border-b" style={{
                color: 'var(--color-text-tertiary)', borderColor: 'var(--color-border-primary)',
                textTransform: 'uppercase',
              }}>
                <div>{t('botWindow')}</div>
                <div style={{ textAlign: 'right' }}>{t('botVolume')}</div>
                <div style={{ textAlign: 'right' }}>APY/ROI</div>
                <div style={{ textAlign: 'right' }}>Score</div>
              </div>
              {snapshots.map((s: Record<string, unknown>) => (
                <div key={s.season_id as string} className="grid grid-cols-4 gap-2 px-4 py-3 border-b last:border-b-0" style={{
                  borderColor: `${tokens.colors.border.primary}30`,
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{s.season_id as string}</div>
                  <div className="text-right text-sm tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                    {formatLargeNumber(s.total_volume as number | null)}
                  </div>
                  <div className="text-right text-sm tabular-nums" style={{
                    color: ((s.apy as number) ?? (s.roi as number) ?? 0) >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
                  }}>
                    {s.apy != null ? formatPercent(s.apy as number) : s.roi != null ? formatPercent(s.roi as number) : '—'}
                  </div>
                  <div className="text-right text-sm font-bold tabular-nums" style={{
                    color: s.arena_score != null ? getScoreColor(Number(s.arena_score)) : 'var(--color-text-tertiary)',
                    fontFamily: tokens.typography.fontFamily.mono.join(','),
                  }}>
                    {s.arena_score != null ? Number(s.arena_score).toFixed(1) : '—'}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* On-chain info */}
        {(bot.contract_address || bot.token_address) && (
          <>
            <h2 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 700, marginBottom: tokens.spacing[3] }}>
              {t('botOnChainInfo')}
            </h2>
            <div style={{
              padding: tokens.spacing[4], borderRadius: tokens.radius.lg,
              background: 'var(--glass-bg-light)', border: `1px solid var(--color-border-primary)`,
              marginBottom: tokens.spacing[6],
            }}>
              {bot.contract_address && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{t('botContractAddress')}</span>
                  <code style={{ fontSize: 12, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{bot.contract_address}</code>
                </div>
              )}
              {bot.token_address && (
                <div>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{t('botTokenAddress')}</span>
                  <code style={{ fontSize: 12, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{bot.token_address}</code>
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
      <Suspense fallback={
        <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
          <TopNav email={null} />
          <div className="max-w-4xl mx-auto px-4 py-6">
            <div style={{ height: 300, borderRadius: tokens.radius.lg, background: 'var(--glass-bg-light)' }} />
          </div>
        </Box>
      }>
        <BotDetailContent id={id} />
      </Suspense>
    </ErrorBoundary>
  )
}
