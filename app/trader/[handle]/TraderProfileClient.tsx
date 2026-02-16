'use client'

import { useState, useCallback } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'

export interface UnregisteredTraderData {
  handle: string
  avatar_url?: string | null
  source: string
  source_trader_id: string
  rank?: number | null
  arena_score?: number | null
  roi?: number | null
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  sharpe_ratio?: number | null
  sortino_ratio?: number | null
  profit_factor?: number | null
  calmar_ratio?: number | null
  trading_style?: string | null
  avg_holding_hours?: number | null
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
}

function formatNumber(val: number | null | undefined, decimals = 2): string {
  if (val == null || isNaN(val)) return '--'
  return val.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function formatPercent(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '--'
  return `${val.toFixed(2)}%`
}

function formatUsd(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '--'
  const abs = Math.abs(val)
  if (abs >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(val / 1_000).toFixed(2)}K`
  return `$${val.toFixed(2)}`
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box style={{
      background: 'var(--color-bg-secondary)',
      borderRadius: tokens.radius.lg,
      padding: tokens.spacing[4],
      flex: '1 1 140px',
      minWidth: 140,
    }}>
      <Text size="xs" style={{ color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{label}</Text>
      <Text size="lg" weight="bold" style={{ color: color || 'var(--color-text-primary)' }}>{value}</Text>
    </Box>
  )
}

function ScoreBar({ label, score }: { label: string; score: number | null | undefined }) {
  const val = score != null ? Math.min(100, Math.max(0, score)) : 0
  return (
    <Box style={{ marginBottom: 12 }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text size="sm" style={{ color: 'var(--color-text-secondary)' }}>{label}</Text>
        <Text size="sm" weight="semibold" style={{ color: 'var(--color-text-primary)' }}>{score != null ? score.toFixed(1) : '--'}</Text>
      </Box>
      <Box style={{
        height: 6,
        background: 'var(--color-bg-tertiary)',
        borderRadius: 3,
        overflow: 'hidden',
      }}>
        <Box style={{
          height: '100%',
          width: `${val}%`,
          background: val >= 70 ? 'var(--color-success)' : val >= 40 ? 'var(--color-warning, #f59e0b)' : 'var(--color-danger)',
          borderRadius: 3,
          transition: 'width 0.3s ease',
        }} />
      </Box>
    </Box>
  )
}

const TRADING_STYLE_MAP: Record<string, string> = {
  scalper: '超短线',
  day_trader: '日内交易',
  swing_trader: '波段交易',
  position_trader: '趋势交易',
  unknown: '未知',
}

export default function TraderProfileClient({ data }: { data: UnregisteredTraderData }) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState(false)
  const exchangeName = EXCHANGE_NAMES[data.source] || data.source
  const displayName = formatDisplayName(data.handle, data.source)
  const gradient = getAvatarGradient(data.handle)
  const initial = getAvatarInitial(data.handle)
  const roiColor = (data.roi ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
  const pnlColor = (data.pnl ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
  const tradingStyle = data.trading_style ? (TRADING_STYLE_MAP[data.trading_style] || data.trading_style) : '--'

  const copyHandle = useCallback(() => {
    navigator.clipboard.writeText(data.handle).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => { /* fallback */ })
  }, [data.handle])

  const structuredData = combineSchemas(
    generateTraderProfilePageSchema({
      handle: data.handle,
      id: data.source_trader_id,
      source: data.source,
      roi90d: data.roi ?? undefined,
      winRate: data.win_rate ?? undefined,
      maxDrawdown: data.max_drawdown ?? undefined,
      arenaScore: data.arena_score ?? undefined,
      avatarUrl: data.avatar_url ?? undefined,
    }),
    generateBreadcrumbSchema([
      { name: 'Home', url: process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org' },
      { name: 'Ranking', url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/rankings` },
      { name: data.handle },
    ])
  )

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <JsonLd data={structuredData} />
      <TopNav />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[4]}` }}>
        <Breadcrumb items={[
          { label: '排行榜', href: '/ranking' },
          { label: displayName },
        ]} />

        {/* Header */}
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[4],
          marginTop: tokens.spacing[4],
          marginBottom: tokens.spacing[6],
        }}>
          {/* Avatar */}
          <Box style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            overflow: 'hidden',
            flexShrink: 0,
            background: data.avatar_url ? undefined : gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {data.avatar_url ? (
              <Image src={`/api/avatar?url=${encodeURIComponent(data.avatar_url)}`} alt={displayName} width={72} height={72} style={{ objectFit: 'cover', width: 72, height: 72 }} />
            ) : (
              <Text size="xl" weight="bold" style={{ color: tokens.colors.white }}>{initial}</Text>
            )}
          </Box>

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], minWidth: 0 }}>
              <Text size="xl" weight="bold" style={{ color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</Text>
              <button
                onClick={copyHandle}
                title={copied ? 'Copied!' : `Copy: ${data.handle}`}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: copied ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                  transition: 'color 0.2s ease',
                  flexShrink: 0,
                }}
              >
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginTop: 4 }}>
              <Text size="sm" style={{
                color: 'var(--color-text-tertiary)',
                background: 'var(--color-bg-tertiary)',
                padding: `2px ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.sm,
              }}>{exchangeName}</Text>
              {data.rank && (
                <Text size="sm" style={{ color: 'var(--color-text-secondary)' }}>#{data.rank}</Text>
              )}
            </Box>
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              {tradingStyle} | 平均持仓 {data.avg_holding_hours != null ? `${data.avg_holding_hours.toFixed(1)}h` : '--'}
            </Text>
          </Box>
        </Box>

        {/* Core Stats */}
        <Box style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[6],
        }}>
          <StatCard label={t('arenaScoreLabel')} value={data.arena_score != null ? formatNumber(data.arena_score, 1) : '--'} />
          <StatCard label="ROI" value={formatPercent(data.roi)} color={roiColor} />
          <StatCard label="PnL" value={formatUsd(data.pnl)} color={pnlColor} />
          <StatCard label={t('winRate')} value={formatPercent(data.win_rate)} />
          <StatCard label={t('maxDrawdown')} value={formatPercent(data.max_drawdown)} color="var(--color-danger)" />
        </Box>

        {/* Dimension Scores */}
        <Box style={{
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[5],
          marginBottom: tokens.spacing[6],
        }}>
          <Text size="md" weight="bold" style={{ color: 'var(--color-text-primary)', marginBottom: tokens.spacing[4], display: 'block' }}>
            {t('dimensionScores')}
          </Text>
          <ScoreBar label={t('profitability')} score={data.profitability_score} />
          <ScoreBar label={t('riskControl')} score={data.risk_control_score} />
          <ScoreBar label={t('execution')} score={data.execution_score} />
        </Box>

        {/* Advanced Metrics */}
        <Box style={{
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[5],
          marginBottom: tokens.spacing[6],
        }}>
          <Text size="md" weight="bold" style={{ color: 'var(--color-text-primary)', marginBottom: tokens.spacing[4], display: 'block' }}>
            高级指标
          </Text>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacing[4] }}>
            {[
              { label: 'Sharpe Ratio', value: formatNumber(data.sharpe_ratio) },
              { label: 'Sortino Ratio', value: formatNumber(data.sortino_ratio) },
              { label: 'Profit Factor', value: formatNumber(data.profit_factor) },
              { label: 'Calmar Ratio', value: formatNumber(data.calmar_ratio) },
            ].map(m => (
              <Box key={m.label}>
                <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>{m.label}</Text>
                <Text size="md" weight="semibold" style={{ color: 'var(--color-text-primary)', marginTop: 2, display: 'block' }}>{m.value}</Text>
              </Box>
            ))}
          </Box>
        </Box>

        {/* Notice */}
        <Box style={{
          background: 'var(--color-bg-tertiary)',
          borderRadius: tokens.radius.md,
          padding: tokens.spacing[4],
          textAlign: 'center',
        }}>
          <Text size="sm" style={{ color: 'var(--color-text-tertiary)' }}>
            该交易员尚未在 Arena 平台注册。数据来自 {exchangeName} 公开排行榜。
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
