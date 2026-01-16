'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'
import TradingViewShell from '../TradingViewShell'

interface StatsPageProps {
  stats: TraderStats
  traderHandle: string
}

export default function StatsPage({ stats, traderHandle }: StatsPageProps) {
  // 常用交易币种
  const frequentlyTraded = stats.frequentlyTraded || []
  
  // 交易统计
  const trading = stats.trading
  
  // 额外统计
  const additionalStats = stats.additionalStats

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
      {/* Asset Breakdown (Frequently Traded) */}
      <BreakdownSection frequentlyTraded={frequentlyTraded} />

      {/* Chart + Compare Two Columns */}
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[6] }}>
        {/* Chart - 7D/30D/90D */}
        <Box bg="secondary" p={0} radius="xl" border="primary" style={{ overflow: 'hidden' }}>
          <TradingViewShell symbol={traderHandle} timeframe="90D" />
        </Box>

        {/* Compare Portfolio */}
        <ComparePortfolioSection traderHandle={traderHandle} />
      </Box>

      {/* Trading Section */}
      <Box bg="secondary" p={6} radius="xl" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
          Trading
        </Text>

        {trading && (trading.totalTrades12M > 0 || trading.profitableTradesPct > 0) ? (
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: tokens.spacing[4],
              marginBottom: tokens.spacing[6],
            }}
          >
            <MiniKpi label="Total Trades (90D)" value={trading.totalTrades12M > 0 ? String(trading.totalTrades12M) : 'N/A'} />
            <MiniKpi
              label="Avg. Profit / Loss"
              value={trading.avgProfit > 0 || trading.avgLoss < 0 
                ? `${trading.avgProfit.toFixed(2)}% / ${trading.avgLoss.toFixed(2)}%`
                : 'N/A'
              }
            />
            <MiniKpi label="Profitable Trades" value={trading.profitableTradesPct > 0 ? `${trading.profitableTradesPct.toFixed(2)}%` : 'N/A'} />
          </Box>
        ) : (
          <Box style={{ padding: tokens.spacing[4], textAlign: 'center', marginBottom: tokens.spacing[6] }}>
            <Text size="sm" color="tertiary">
              交易统计数据暂不可用
            </Text>
          </Box>
        )}

        {/* Frequently Traded */}
        {frequentlyTraded.length > 0 && (
          <>
            <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
              Frequently traded
            </Text>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[6] }}>
              {frequentlyTraded.slice(0, 5).map((item, idx) => (
                <Box
                  key={idx}
                  bg="primary"
                  p={4}
                  radius="lg"
                  border="secondary"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px 1fr 120px',
                    gap: tokens.spacing[3],
                    alignItems: 'center',
                  }}
                >
                  <Box>
                    <Text size="sm" weight="black">{item.symbol}</Text>
                    <Text size="xs" color="tertiary">{item.weightPct.toFixed(2)}%</Text>
                  </Box>
                  <Box style={{ fontSize: tokens.typography.fontSize.xs }}>
                    <Box style={{ marginBottom: tokens.spacing[1] }}>
                      <Text size="xs" weight="black" style={{ color: tokens.colors.accent.success, marginRight: tokens.spacing[1] }}>
                        +{item.avgProfit.toFixed(2)}%
                      </Text>
                      <Text size="xs" color="secondary">Avg. Profit</Text>
                    </Box>
                    <Box>
                      <Text size="xs" weight="black" style={{ color: tokens.colors.accent.error, marginRight: tokens.spacing[1] }}>
                        {item.avgLoss.toFixed(2)}%
                      </Text>
                      <Text size="xs" color="secondary">Avg. Loss</Text>
                    </Box>
                  </Box>
                  <Box style={{ textAlign: 'right' }}>
                    <Text size="sm" weight="black">{item.profitablePct.toFixed(2)}%</Text>
                    <Text size="xs" color="tertiary">Profitable</Text>
                  </Box>
                </Box>
              ))}
            </Box>
          </>
        )}

        {/* Additional Stats - 只显示有数据的字段 */}
        <Box>
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            Additional stats
          </Text>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
            <MiniKpi 
              label="Avg. holdings time" 
              value={additionalStats?.avgHoldingTime || 'N/A'} 
            />
            <MiniKpi 
              label="最大回撤" 
              value={additionalStats?.maxDrawdown !== undefined ? `${additionalStats.maxDrawdown.toFixed(2)}%` : 'N/A'} 
            />
            <MiniKpi 
              label="Tracked since" 
              value={additionalStats?.activeSince || 'N/A'} 
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// Helper Components
function MiniKpi({ label, value }: { label: string; value: string }) {
  return (
    <Box bg="primary" p={3} radius="lg" border="secondary">
      <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal, marginBottom: tokens.spacing[1] }}>
        {label}
      </Text>
      <Text size="lg" weight="black" style={{ color: value === 'N/A' ? tokens.colors.text.tertiary : tokens.colors.text.primary }}>
        {value}
      </Text>
    </Box>
  )
}

// Compare Portfolio Section with 7D/30D/90D selector
function ComparePortfolioSection({ traderHandle }: { traderHandle: string }) {
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [compareWith, setCompareWith] = useState<'BTC' | 'ETH' | 'SPX500'>('BTC')

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary">
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="black">Compare portfolio</Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as '7D' | '30D' | '90D')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
            }}
          >
            <option value="7D">7D</option>
            <option value="30D">30D</option>
            <option value="90D">90D</option>
          </select>
          <select
            value={compareWith}
            onChange={(e) => setCompareWith(e.target.value as 'BTC' | 'ETH' | 'SPX500')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
            }}
          >
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
            <option value="SPX500">SPX500</option>
          </select>
        </Box>
      </Box>

      {/* Compare Chart Placeholder */}
      <Box style={{ marginTop: tokens.spacing[4], marginBottom: tokens.spacing[3] }}>
        <CompareChart height={220} period={period} />
      </Box>

      {/* Compare Rows */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        <CompareRow name={traderHandle} pct={undefined} />
        <CompareRow name={compareWith} pct={undefined} />
      </Box>
      
      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[3], fontStyle: 'italic' }}>
        对比数据需要更多历史数据支持
      </Text>
    </Box>
  )
}

function CompareChart({ height, period }: { height: number; period: string }) {
  return (
    <Box
      style={{
        height,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: `radial-gradient(700px 260px at 50% 20%, rgba(139, 111, 168, 0.1), transparent 55%), ${tokens.colors.bg.primary}`,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.18,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundSize: '70px 70px',
        }}
      />
      <Text size="sm" color="tertiary">
        {period} 对比图表（数据加载中...）
      </Text>
    </Box>
  )
}

function CompareRow({ name, pct }: { name: string; pct?: number }) {
  return (
    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text size="sm" weight="black" style={{ color: tokens.colors.text.secondary }}>
        {name}
      </Text>
      <Text
        size="sm"
        weight="black"
        style={{
          color: pct !== undefined 
            ? (pct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
            : tokens.colors.text.tertiary,
        }}
      >
        {pct !== undefined ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : 'N/A'}
      </Text>
    </Box>
  )
}

// Breakdown Section (Asset Preference)
function BreakdownSection({ frequentlyTraded }: { frequentlyTraded: Array<{ symbol: string; weightPct: number }> }) {
  if (frequentlyTraded.length === 0) {
    return (
      <Box bg="secondary" p={6} radius="xl" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
          Asset Breakdown
        </Text>
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            资产分布数据暂不可用
          </Text>
        </Box>
      </Box>
    )
  }

  const totalPct = frequentlyTraded.reduce((sum, item) => sum + item.weightPct, 0)

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary">
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="black">Asset Breakdown</Text>
      </Box>

      {/* 横条图 */}
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', height: 24, borderRadius: tokens.radius.lg, overflow: 'hidden' }}>
          {frequentlyTraded.slice(0, 5).map((item, idx) => (
            <Box
              key={idx}
              style={{
                width: `${(item.weightPct / totalPct) * 100}%`,
                background: getColorForIndex(idx),
                minWidth: 4,
              }}
            />
          ))}
        </Box>
      </Box>

      {/* Asset List */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        <Box style={{ display: 'flex', justifyContent: 'space-between', padding: `${tokens.spacing[2]} 0`, borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
          <Text size="xs" color="tertiary">Asset ({frequentlyTraded.length})</Text>
          <Text size="xs" color="tertiary">Weight</Text>
        </Box>
        {frequentlyTraded.slice(0, 5).map((item, idx) => (
          <Box key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${tokens.spacing[2]} 0` }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Box style={{ width: 12, height: 12, borderRadius: 2, background: getColorForIndex(idx) }} />
              <Text size="sm" weight="bold">{item.symbol}</Text>
            </Box>
            <Text size="sm" color="secondary">{item.weightPct.toFixed(2)}%</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function getColorForIndex(idx: number): string {
  const colors = [
    'rgba(139, 111, 168, 0.85)',
    'rgba(47, 229, 125, 0.85)',
    'rgba(255, 193, 7, 0.85)',
    'rgba(33, 150, 243, 0.85)',
    'rgba(255, 77, 77, 0.85)',
  ]
  return colors[idx % colors.length]
}
