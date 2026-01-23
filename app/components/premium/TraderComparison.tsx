'use client'

import React from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { useLanguage } from '../Providers/LanguageProvider'

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  avatar_url?: string
  followers?: number
}

interface TraderComparisonProps {
  traders: TraderCompareData[]
  onRemove?: (traderId: string) => void
  showRemoveButton?: boolean
}

// 格式化数字
function formatNumber(num: number | undefined | null, decimals = 2): string {
  if (num == null) return '—'
  return num.toFixed(decimals)
}

// 格式化 PnL
function formatPnL(pnl: number | undefined | null): string {
  if (pnl == null) return '—'
  const absPnL = Math.abs(pnl)
  if (absPnL >= 1000000) {
    return `$${(pnl / 1000000).toFixed(2)}M`
  } else if (absPnL >= 1000) {
    return `$${(pnl / 1000).toFixed(2)}K`
  }
  return `$${pnl.toFixed(2)}`
}

// 获取数值的颜色
function getValueColor(value: number | undefined | null, isPositiveGood = true): string {
  if (value == null) return tokens.colors.text.tertiary
  if (isPositiveGood) {
    return value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  }
  return value <= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

// 获取最佳值的索引
function getBestIndex(values: (number | undefined | null)[], isHigherBetter = true): number {
  let bestIdx = -1
  let bestVal = isHigherBetter ? -Infinity : Infinity
  
  values.forEach((val, idx) => {
    if (val != null) {
      if (isHigherBetter ? val > bestVal : val < bestVal) {
        bestVal = val
        bestIdx = idx
      }
    }
  })
  
  return bestIdx
}

// 来源标签映射
const sourceLabels: Record<string, string> = {
  'binance_futures': 'Binance 合约',
  'binance_spot': 'Binance 现货',
  'binance_web3': 'Binance 链上',
  'bybit': 'Bybit 合约',
  'bitget_futures': 'Bitget 合约',
  'bitget_spot': 'Bitget 现货',
  'mexc': 'MEXC 合约',
  'coinex': 'CoinEx 合约',
  'okx_web3': 'OKX 链上',
  'kucoin': 'KuCoin 合约',
  'gmx': 'GMX 链上',
}

export default function TraderComparison({ traders, onRemove, showRemoveButton = true }: TraderComparisonProps) {
  const { t: _t } = useLanguage()
  
  if (traders.length === 0) {
    return (
      <Box
        style={{
          padding: tokens.spacing[8],
          textAlign: 'center',
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="lg" color="tertiary">
          请添加交易员进行对比
        </Text>
        <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
          最多可对比 5 位交易员
        </Text>
      </Box>
    )
  }

  // 指标行配置
  const metrics = [
    { key: 'arena_score', label: 'Arena Score', format: (v: number) => formatNumber(v, 1), higherBetter: true },
    { key: 'roi', label: 'ROI (90D)', format: (v: number) => `${v >= 0 ? '+' : ''}${formatNumber(v)}%`, higherBetter: true, isPercent: true },
    { key: 'roi_30d', label: 'ROI (30D)', format: (v: number) => `${v >= 0 ? '+' : ''}${formatNumber(v)}%`, higherBetter: true, isPercent: true },
    { key: 'roi_7d', label: 'ROI (7D)', format: (v: number) => `${v >= 0 ? '+' : ''}${formatNumber(v)}%`, higherBetter: true, isPercent: true },
    { key: 'pnl', label: 'PnL', format: formatPnL, higherBetter: true },
    { key: 'win_rate', label: '胜率', format: (v: number) => `${formatNumber(v, 1)}%`, higherBetter: true },
    { key: 'max_drawdown', label: '最大回撤', format: (v: number) => `-${formatNumber(Math.abs(v))}%`, higherBetter: false, isNegative: true },
    { key: 'trades_count', label: '交易次数', format: (v: number) => v?.toString() || '—', higherBetter: true },
    { key: 'return_score', label: '收益分', format: (v: number) => formatNumber(v, 1), higherBetter: true },
    { key: 'drawdown_score', label: '回撤分', format: (v: number) => formatNumber(v, 1), higherBetter: true },
    { key: 'stability_score', label: '稳定分', format: (v: number) => formatNumber(v, 1), higherBetter: true },
    { key: 'followers', label: '关注数', format: (v: number) => v?.toString() || '0', higherBetter: true },
  ]

  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* 表头：交易员信息 */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: `140px repeat(${traders.length}, 1fr)`,
          gap: tokens.spacing[2],
          padding: tokens.spacing[4],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
        }}
      >
        <Box /> {/* 空白单元格 */}
        {traders.map((trader, _idx) => (
          <Box
            key={trader.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: tokens.spacing[2],
              position: 'relative',
            }}
          >
            {/* 删除按钮 */}
            {showRemoveButton && onRemove && (
              <button
                onClick={() => onRemove(trader.id)}
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 24,
                  height: 24,
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.accent.error,
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'transform 0.2s',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                ×
              </button>
            )}
            
            {/* 头像 */}
            <Link href={`/trader/${encodeURIComponent(trader.id)}`}>
              <Box
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: tokens.radius.full,
                  background: trader.avatar_url ? tokens.colors.bg.secondary : getAvatarGradient(trader.id),
                  border: `2px solid ${tokens.colors.border.primary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
              >
                {trader.avatar_url ? (
                  <img
                    src={trader.avatar_url}
                    alt={trader.handle || trader.id}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Text size="lg" weight="black" style={{ color: '#fff' }}>
                    {getAvatarInitial(trader.handle || trader.id)}
                  </Text>
                )}
              </Box>
            </Link>
            
            {/* 名称 */}
            <Link href={`/trader/${encodeURIComponent(trader.id)}`} style={{ textDecoration: 'none' }}>
              <Text
                size="sm"
                weight="bold"
                style={{
                  color: tokens.colors.text.primary,
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'center',
                }}
              >
                {trader.handle || trader.id.slice(0, 10)}
              </Text>
            </Link>
            
            {/* 来源标签 */}
            <Text size="xs" color="tertiary">
              {sourceLabels[trader.source] || trader.source}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 指标行 */}
      {metrics.map((metric, metricIdx) => {
        const values = traders.map(t => (t as any)[metric.key])
        const bestIdx = getBestIndex(values, metric.higherBetter)
        
        return (
          <Box
            key={metric.key}
            style={{
              display: 'grid',
              gridTemplateColumns: `140px repeat(${traders.length}, 1fr)`,
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: metricIdx < metrics.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
              background: metricIdx % 2 === 0 ? 'transparent' : `${tokens.colors.bg.tertiary}50`,
            }}
          >
            {/* 指标名称 */}
            <Text size="sm" weight="semibold" color="secondary">
              {metric.label}
            </Text>
            
            {/* 各交易员的值 */}
            {traders.map((trader, traderIdx) => {
              const value = (trader as any)[metric.key]
              const isBest = traderIdx === bestIdx && value != null
              const color = metric.isPercent || metric.isNegative
                ? getValueColor(value, metric.higherBetter)
                : isBest
                  ? tokens.colors.accent.success
                  : tokens.colors.text.primary
              
              return (
                <Box
                  key={trader.id}
                  style={{
                    textAlign: 'center',
                    position: 'relative',
                  }}
                >
                  <Text
                    size="sm"
                    weight={isBest ? 'black' : 'semibold'}
                    style={{
                      color,
                      position: 'relative',
                    }}
                  >
                    {value != null ? metric.format(value) : '—'}
                    {isBest && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -2,
                          right: -16,
                          fontSize: 10,
                          color: tokens.colors.accent.success,
                        }}
                      >
                        ★
                      </span>
                    )}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}
