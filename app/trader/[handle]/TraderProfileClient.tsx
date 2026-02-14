'use client'

import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import Image from 'next/image'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatDisplayName } from '@/app/components/ranking/utils'

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
  const exchangeName = EXCHANGE_NAMES[data.source] || data.source
  const displayName = formatDisplayName(data.handle, data.source)
  const gradient = getAvatarGradient(data.handle)
  const initial = getAvatarInitial(data.handle)
  const roiColor = (data.roi ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
  const pnlColor = (data.pnl ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
  const tradingStyle = data.trading_style ? (TRADING_STYLE_MAP[data.trading_style] || data.trading_style) : '--'

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
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
              <Image src={data.avatar_url} alt={displayName} width={72} height={72} style={{ objectFit: 'cover' }} />
            ) : (
              <Text size="xl" weight="bold" style={{ color: tokens.colors.white }}>{initial}</Text>
            )}
          </Box>

          <Box style={{ flex: 1 }}>
            <Text size="xl" weight="bold" style={{ color: 'var(--color-text-primary)' }}>{displayName}</Text>
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
          <StatCard label="Arena 评分" value={data.arena_score != null ? formatNumber(data.arena_score, 1) : '--'} />
          <StatCard label="ROI" value={formatPercent(data.roi)} color={roiColor} />
          <StatCard label="PnL" value={formatUsd(data.pnl)} color={pnlColor} />
          <StatCard label="胜率" value={formatPercent(data.win_rate)} />
          <StatCard label="最大回撤" value={formatPercent(data.max_drawdown)} color="var(--color-danger)" />
        </Box>

        {/* Dimension Scores */}
        <Box style={{
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[5],
          marginBottom: tokens.spacing[6],
        }}>
          <Text size="md" weight="bold" style={{ color: 'var(--color-text-primary)', marginBottom: tokens.spacing[4], display: 'block' }}>
            维度评分
          </Text>
          <ScoreBar label="盈利能力" score={data.profitability_score} />
          <ScoreBar label="风控能力" score={data.risk_control_score} />
          <ScoreBar label="执行能力" score={data.execution_score} />
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
