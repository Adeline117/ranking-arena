
/**
 * TokenDistribution - 代币持仓分布可视化
 * 使用纯 CSS 水平条形图展示各代币占比
 */

import { tokens } from '@/lib/design-tokens'

interface TokenDistributionItem {
  symbol: string
  balance: number
  percentage: number
}

interface TokenDistributionProps {
  data: TokenDistributionItem[]
}

const BAR_COLORS = [
  'var(--color-accent-primary)',
  'var(--color-accent-success)',
  'var(--color-accent-warning, #FFB800)',
  'var(--color-brand)',
  'var(--color-accent-error)',
  'var(--color-verified-web3)',
  'var(--color-enterprise-gradient-start)',
  'var(--color-score-below)',
]

export default function TokenDistribution({ data }: TokenDistributionProps) {
  if (!data.length) {
    return (
      <div style={{ color: tokens.colors.text.secondary, padding: tokens.spacing[4] }}>
        暂无代币持仓数据
      </div>
    )
  }

  return (
    <div
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[4],
      }}
    >
      <h4
        style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 600,
          marginBottom: tokens.spacing[3],
          marginTop: 0,
        }}
      >
        持仓分布
      </h4>

      {/* 总览条 */}
      <div
        style={{
          display: 'flex',
          height: '12px',
          borderRadius: tokens.radius.sm,
          overflow: 'hidden',
          marginBottom: tokens.spacing[4],
        }}
      >
        {data.map((item, i) => (
          <div
            key={item.symbol}
            style={{
              width: `${Math.max(item.percentage, 1)}%`,
              backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
              transition: 'width 0.3s ease',
            }}
            title={`${item.symbol}: ${item.percentage.toFixed(1)}%`}
          />
        ))}
      </div>

      {/* 明细列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {data.map((item, i) => (
          <div
            key={item.symbol}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
            }}
          >
            <div
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '2px',
                backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                flexShrink: 0,
              }}
            />
            <span
              style={{
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 500,
                minWidth: '60px',
              }}
            >
              {item.symbol}
            </span>
            <div
              style={{
                flex: 1,
                height: '6px',
                backgroundColor: tokens.colors.bg.tertiary,
                borderRadius: '3px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${item.percentage}%`,
                  height: '100%',
                  backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                  borderRadius: '3px',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span
              style={{
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontFamily: 'monospace',
                minWidth: '80px',
                textAlign: 'right',
              }}
            >
              {item.balance.toFixed(2)} ({item.percentage.toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
