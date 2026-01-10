'use client'

import { useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'
import TradingViewShell from '../TradingViewShell'
import { useLanguage } from '../../Utils/LanguageProvider'

interface StatsPageProps {
  stats: TraderStats
  traderHandle: string
}

export default function StatsPage({ stats, traderHandle }: StatsPageProps) {
  const { t } = useLanguage()
  
  // Performance月度数据
  const monthlyData = useMemo(() => {
    return stats.monthlyPerformance || [
      { month: 'Jan', value: -7.68 },
      { month: 'Feb', value: -0.78 },
      { month: 'Mar', value: 6.31 },
      { month: 'Apr', value: 6.19 },
      { month: 'May', value: 13.15 },
      { month: 'Jun', value: -7.63 },
      { month: 'Jul', value: -7.03 },
      { month: 'Aug', value: 7.69 },
      { month: 'Sep', value: -1.36 },
      { month: 'Oct', value: -4.01 },
      { month: 'Nov', value: -7.65 },
      { month: 'Dec', value: 3.88 },
    ]
  }, [stats.monthlyPerformance])

  // 常用交易币种
  const frequentlyTraded = stats.frequentlyTraded || [
    {
      symbol: 'AVAX',
      weightPct: 8.13,
      count: 0,
      avgProfit: 74.02,
      avgLoss: -16.58,
      profitablePct: 78.31,
    },
    {
      symbol: 'LINK',
      weightPct: 11.01,
      count: 0,
      avgProfit: 103.85,
      avgLoss: -38.93,
      profitablePct: 43.0,
    },
    {
      symbol: 'BTC',
      weightPct: 11.78,
      count: 0,
      avgProfit: 4.72,
      avgLoss: -39.29,
      profitablePct: 88.27,
    },
  ]

  // 交易统计
  const trading = stats.trading || {
    totalTrades12M: 269,
    avgProfit: 279.16,
    avgLoss: -113.74,
    profitableTradesPct: 54.8,
  }

  // 额外统计
  const additionalStats = stats.additionalStats || {
    tradesPerWeek: 2.19,
    avgHoldingTime: '31.5 Days',
    activeSince: '2022-02-08',
    profitableWeeksPct: 54.39,
  }

  const traderReturn = 55.07
  const spx500Return = 16.42

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
      {/* Performance Section */}
      <Box bg="secondary" p={6} radius="xl" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
          Performance
        </Text>

        {/* Bar Chart */}
        <Box style={{ marginTop: tokens.spacing[4], marginBottom: tokens.spacing[4] }}>
          <PerformanceBarChart data={monthlyData} />
        </Box>

        {/* Month Labels */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(12, 1fr)',
            gap: tokens.spacing[2],
            marginTop: tokens.spacing[2],
          }}
        >
          {monthlyData.map((item, i) => (
            <Text
              key={i}
              size="xs"
              color="tertiary"
              style={{ textAlign: 'center', fontWeight: tokens.typography.fontWeight.normal }}
            >
              {item.month}
            </Text>
          ))}
        </Box>

        {/* Monthly Grid */}
        <Box
          bg="primary"
          p={3}
          radius="lg"
          border="secondary"
          style={{
            marginTop: tokens.spacing[3],
            display: 'grid',
            gridTemplateColumns: '60px repeat(12, 1fr)',
            gap: tokens.spacing[2],
            alignItems: 'center',
            fontSize: tokens.typography.fontSize.xs,
          }}
        >
          <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal }}>
            2025
          </Text>
          {monthlyData.map((item, i) => (
            <Box
              key={i}
              style={{
                textAlign: 'center',
                padding: `${tokens.spacing[1]} 0`,
                borderRadius: tokens.radius.md,
                background: item.value >= 0
                  ? 'rgba(47, 229, 125, 0.12)'
                  : 'rgba(255, 77, 77, 0.12)',
                color: item.value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                fontWeight: tokens.typography.fontWeight.black,
              }}
            >
              {item.value >= 0 ? '+' : ''}
              {item.value.toFixed(2)}%
            </Box>
          ))}
        </Box>

        <Text
          size="xs"
          color="tertiary"
          style={{ marginTop: tokens.spacing[3], fontStyle: 'italic' }}
        >
          Past performance is not indicative of future results.
        </Text>
      </Box>

      {/* Breakdown Section */}
      <BreakdownSection frequentlyTraded={frequentlyTraded} />

      {/* Chart + Compare Two Columns */}
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[6] }}>
        {/* Chart */}
        <Box bg="secondary" p={0} radius="xl" border="primary" style={{ overflow: 'hidden' }}>
          <TradingViewShell symbol={traderHandle} timeframe="1Y" />
        </Box>

        {/* Compare Portfolio */}
        <Box bg="secondary" p={6} radius="xl" border="primary">
          <Box
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="lg" weight="black">
              Compare portfolio
            </Text>
            <select
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option>SPX500</option>
              <option>BTC</option>
              <option>ETH</option>
            </select>
          </Box>

          {/* Compare Chart */}
          <Box style={{ marginTop: tokens.spacing[4], marginBottom: tokens.spacing[3] }}>
            <CompareChart height={220} />
          </Box>

          {/* Compare Rows */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <CompareRow name={traderHandle} pct={traderReturn} />
            <CompareRow name="SPX500" pct={spx500Return} />
          </Box>
        </Box>
      </Box>

      {/* Trading Section */}
      <Box bg="secondary" p={6} radius="xl" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
          Trading
        </Text>

        {/* Trading Stats */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[6],
          }}
        >
          <MiniKpi label="Total Trades (12M)" value={String(trading.totalTrades12M)} />
          <MiniKpi
            label="Avg. Profit / Loss"
            value={`${trading.avgProfit.toFixed(2)} / ${trading.avgLoss.toFixed(2)}`}
          />
          <MiniKpi label="Profitable Trades" value={`${trading.profitableTradesPct.toFixed(2)}%`} />
        </Box>

        {/* Frequently Traded */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[4],
          }}
        >
          <Text size="lg" weight="black">
            Frequently traded
          </Text>
          <button
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
            }}
          >
            View all
          </button>
        </Box>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[6] }}>
          {frequentlyTraded.map((item, idx) => (
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
                <Text size="sm" weight="black">
                  {item.symbol}
                </Text>
                <Text size="xs" color="tertiary">
                  {item.weightPct.toFixed(2)}%
                </Text>
              </Box>

              <Box style={{ fontSize: tokens.typography.fontSize.xs }}>
                <Box style={{ marginBottom: tokens.spacing[1] }}>
                  <Text
                    size="xs"
                    weight="black"
                    style={{
                      color: tokens.colors.accent.success,
                      marginRight: tokens.spacing[1],
                    }}
                  >
                    +{item.avgProfit.toFixed(2)}%
                  </Text>
                  <Text size="xs" color="secondary">
                    Avg. Profit
                  </Text>
                </Box>
                <Box>
                  <Text
                    size="xs"
                    weight="black"
                    style={{
                      color: tokens.colors.accent.error,
                      marginRight: tokens.spacing[1],
                    }}
                  >
                    {item.avgLoss.toFixed(2)}%
                  </Text>
                  <Text size="xs" color="secondary">
                    Avg. Loss
                  </Text>
                </Box>
              </Box>

              <Box style={{ textAlign: 'right' }}>
                <Text size="sm" weight="black">
                  {item.profitablePct.toFixed(2)}%
                </Text>
                <Text size="xs" color="tertiary">
                  Profitable
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        {/* Additional Stats */}
        <Box>
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            Additional stats
          </Text>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacing[4] }}>
            <MiniKpi 
              label="Trades per week" 
              value={additionalStats.tradesPerWeek.toFixed(2)} 
              tooltip="Derived from public leaderboard snapshots"
            />
            <MiniKpi 
              label="Avg. holdings time" 
              value={additionalStats.avgHoldingTime} 
              tooltip="Derived from public leaderboard snapshots"
            />
            <MiniKpi 
              label="Tracked since (first seen in Arena)" 
              value="—" 
              isPlaceholder={true}
            />
            <MiniKpi 
              label="Profitable weeks" 
              value={`${additionalStats.profitableWeeksPct.toFixed(2)}%`} 
              tooltip="Derived from public leaderboard snapshots"
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// Helper Components
function MiniKpi({ 
  label, 
  value, 
  tooltip, 
  isPlaceholder = false 
}: { 
  label: string
  value: string
  tooltip?: string
  isPlaceholder?: boolean
}) {
  const [showTooltip, setShowTooltip] = useState(false)
  
  return (
    <Box
      bg="primary"
      p={3}
      radius="lg"
      border="secondary"
      style={{ position: 'relative' }}
    >
      <Box 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: tokens.spacing[1],
          marginBottom: tokens.spacing[1],
        }}
      >
        <Text 
          size="xs" 
          color="tertiary" 
          style={{ fontWeight: tokens.typography.fontWeight.normal }}
        >
          {label}
        </Text>
        {tooltip && (
          <Box
            style={{
              position: 'relative',
              cursor: 'help',
            }}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <Text size="xs" color="tertiary" style={{ fontSize: '12px' }}>
              ℹ️
            </Text>
            {showTooltip && (
              <Box
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: tokens.spacing[2],
                  padding: tokens.spacing[2],
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  boxShadow: tokens.shadow.md,
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.secondary,
                  whiteSpace: 'nowrap',
                  zIndex: 1000,
                  maxWidth: '250px',
                }}
              >
                {tooltip}
              </Box>
            )}
          </Box>
        )}
      </Box>
      <Text 
        size="lg" 
        weight="black"
        style={{
          color: isPlaceholder ? tokens.colors.text.tertiary : tokens.colors.text.primary,
        }}
      >
        {isPlaceholder && value === '—' ? 'Unlock by connecting exchange account' : value}
      </Text>
    </Box>
  )
}

function PerformanceBarChart({ data }: { data: Array<{ month: string; value: number }> }) {
  const maxValue = Math.max(...data.map((d) => Math.abs(d.value)), 1)
  const height = 180
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <Box
      style={{
        height,
        display: 'flex',
        alignItems: 'flex-end',
        gap: tokens.spacing[2],
        position: 'relative',
      }}
    >
      {data.map((item, i) => {
        const barHeight = Math.round((Math.abs(item.value) / maxValue) * (height - 20))
        const isPos = item.value >= 0
        const isHovered = hoveredIndex === i

        return (
          <Box
            key={i}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              position: 'relative',
            }}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <Box
              style={{
                height: barHeight,
                borderRadius: tokens.radius.md,
                background: isPos
                  ? 'rgba(47, 229, 125, 0.55)'
                  : 'rgba(255, 77, 77, 0.55)',
                border: `1px solid ${tokens.colors.border.primary}`,
                minHeight: 4,
                cursor: 'pointer',
              }}
            />
            {isHovered && (
              <Box
                style={{
                  position: 'absolute',
                  bottom: barHeight + tokens.spacing[2],
                  left: '50%',
                  transform: 'translateX(-50%)',
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.primary,
                  whiteSpace: 'nowrap',
                  zIndex: 1000,
                  pointerEvents: 'none',
                }}
              >
                {item.month} 2025: {item.value >= 0 ? '+' : ''}
                {item.value.toFixed(2)}%
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function CompareChart({ height }: { height: number }) {
  return (
    <Box
      style={{
        height,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: `radial-gradient(700px 260px at 50% 20%, rgba(139, 111, 168, 0.1), transparent 55%), ${tokens.colors.bg.primary}`,
        position: 'relative',
        overflow: 'hidden',
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
      <Box
        style={{
          position: 'absolute',
          left: tokens.spacing[3],
          bottom: tokens.spacing[3],
          display: 'flex',
          gap: tokens.spacing[3],
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.xs,
        }}
      >
        <span>1W</span>
        <span>1M</span>
        <span>6M</span>
        <span style={{ color: tokens.colors.text.primary }}>1Y</span>
        <span>5Y</span>
      </Box>

      <svg
        width="100%"
        height="100%"
        viewBox="0 0 600 260"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0 }}
      >
        <path
          d="M0,180 C80,120 140,210 220,160 C300,110 340,140 420,90 C500,70 540,130 600,100"
          fill="none"
          stroke="rgba(139, 111, 168, 0.85)"
          strokeWidth="2"
        />
        <path
          d="M0,190 C120,180 180,200 260,185 C340,170 420,175 520,165 C560,160 590,158 600,156"
          fill="none"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth="2"
        />
      </svg>
    </Box>
  )
}

function CompareRow({ name, pct }: { name: string; pct: number }) {
  return (
    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text size="sm" weight="black" style={{ color: tokens.colors.text.secondary }}>
        {name}
      </Text>
      <Text
        size="sm"
        weight="black"
        style={{
          color: pct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
        }}
      >
        {pct >= 0 ? '+' : ''}
        {pct.toFixed(2)}%
      </Text>
    </Box>
  )
}

// Breakdown Section
function BreakdownSection({ frequentlyTraded }: { frequentlyTraded: Array<{ symbol: string; weightPct: number }> }) {
  // 计算Stocks和Crypto的比例（这里简化处理，实际应该从portfolio数据获取）
  const stocksPct = 91.13 // 默认值
  const cryptoPct = 8.87
  const totalPct = stocksPct + cryptoPct

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary">
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text size="lg" weight="black">
          Breakdown
        </Text>
        <select
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.bold,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option>Asset Type</option>
          <option>Symbol</option>
        </select>
      </Box>

      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text as="span" size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
          This breakdown includes <Text as="span" weight="bold" style={{ color: tokens.colors.text.primary }}>{totalPct.toFixed(1)}%</Text> of this Portfolio
        </Text>
      </Box>

      {/* Horizontal Bar Chart */}
      <Box style={{ display: 'flex', gap: 0, marginBottom: tokens.spacing[4], borderRadius: tokens.radius.md, overflow: 'hidden' }}>
        <Box
          style={{
            width: `${stocksPct}%`,
            height: 40,
            background: 'rgba(59, 130, 246, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.black,
          }}
        >
          Stocks {stocksPct.toFixed(1)}%
        </Box>
        <Box
          style={{
            width: `${cryptoPct}%`,
            height: 40,
            background: 'rgba(251, 146, 60, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.black,
          }}
        >
          Crypto {cryptoPct.toFixed(1)}%
        </Box>
      </Box>

      {/* Asset List */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        <Box style={{ display: 'flex', justifyContent: 'space-between', padding: `${tokens.spacing[2]} 0`, borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
          <Text size="xs" color="tertiary">Asset ({frequentlyTraded.length})</Text>
          <Text size="xs" color="tertiary">Portfolio Weight</Text>
        </Box>
        {frequentlyTraded.slice(0, 5).map((item, idx) => (
          <Box key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: `${tokens.spacing[2]} 0` }}>
            <Text size="sm" weight="bold">{item.symbol}</Text>
            <Text size="sm" color="secondary">{item.weightPct.toFixed(2)}%</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

