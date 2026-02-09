'use client'

import { memo, useState, useMemo } from 'react'
import Link from 'next/link'
import { X, TrendingUp, TrendingDown, Minus, ChevronUp, ChevronDown, BarChart3, Share2, Maximize2 } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'
import { formatCompact as formatNumber, formatPercent } from '@/lib/utils/format'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from '../ranking/RankingTable'

type CompareTradersProps = {
  traders: Trader[]
  onRemove: (id: string) => void
  onClear: () => void
  maxTraders?: number
}

type CompareMetric = {
  key: keyof Trader
  label: string
  format: (value: number | undefined | null) => string
  higherIsBetter: boolean
  colorize?: boolean
}

function getCompareMetrics(t: (key: string) => string): CompareMetric[] {
  return [
    {
      key: 'roi',
      label: t('roi'),
      format: (v) => v != null ? formatPercent(v) : '—',
      higherIsBetter: true,
      colorize: true,
    },
    {
      key: 'pnl',
      label: t('totalPnl'),
      format: (v) => v != null ? `$${formatNumber(v)}` : '—',
      higherIsBetter: true,
      colorize: true,
    },
    {
      key: 'win_rate',
      label: t('winRate'),
      format: (v) => v != null ? `${Math.round(v)}%` : '—',
      higherIsBetter: true,
    },
    {
      key: 'max_drawdown',
      label: t('maxDrawdown'),
      format: (v) => v != null ? `${Math.abs(v).toFixed(1)}%` : '—',
      higherIsBetter: false,
      colorize: true,
    },
    {
      key: 'arena_score',
      label: 'Arena Score',
      format: (v) => v != null ? v.toFixed(1) : '—',
      higherIsBetter: true,
    },
    {
      key: 'followers',
      label: t('compareFollowers'),
      format: (v) => v != null ? formatNumber(v) : '—',
      higherIsBetter: true,
    },
  ]
}

function getBestValue(traders: Trader[], metric: CompareMetric): number | null {
  const values = traders
    .map(t => t[metric.key] as number | undefined)
    .filter((v): v is number => v != null)

  if (values.length === 0) return null

  return metric.higherIsBetter
    ? Math.max(...values)
    : Math.min(...values)
}

function getValueColor(value: number | undefined | null, metric: CompareMetric, bestValue: number | null): string {
  if (value == null || bestValue == null) return tokens.colors.text.secondary

  if (!metric.colorize) {
    return value === bestValue ? tokens.colors.accent?.success : tokens.colors.text.primary
  }

  // 对于有颜色的指标
  if (metric.key === 'max_drawdown') {
    return tokens.colors.accent?.error
  }

  return value >= 0
    ? (tokens.colors.accent?.success)
    : (tokens.colors.accent?.error)
}

function TrendIcon({ value, metric }: { value: number | undefined | null; metric: CompareMetric }) {
  if (value == null) return <Minus size={12} style={{ opacity: 0.5 }} />

  if (metric.key === 'max_drawdown') {
    return <TrendingDown size={12} style={{ color: tokens.colors.accent?.error }} />
  }

  if (value > 0) {
    return <TrendingUp size={12} style={{ color: tokens.colors.accent?.success }} />
  } else if (value < 0) {
    return <TrendingDown size={12} style={{ color: tokens.colors.accent?.error }} />
  }

  return <Minus size={12} style={{ opacity: 0.5 }} />
}

function CompareFloatingBar({
  traders,
  onRemove,
  onClear,
  onExpand,
}: CompareTradersProps & { onExpand: () => void }) {
  const { t } = useLanguage()
  return (
    <Box
      role="region"
      aria-label={t('compareTraders')}
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: 16,
        padding: 16,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
        zIndex: tokens.zIndex.popover,
        minWidth: 280,
        maxWidth: 400,
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* 头部 */}
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={18} style={{ color: tokens.colors.accent?.primary || tokens.colors.accent.brand }} />
          <Text size="sm" weight="bold">
            {t('compare')} ({traders.length}/5)
          </Text>
        </Box>
        <Box style={{ display: 'flex', gap: 4 }}>
          <Button
            variant="text"
            size="sm"
            onClick={onExpand}
            aria-label={t('expandAll')}
            style={{ padding: 6, borderRadius: 8 }}
          >
            <Maximize2 size={16} />
          </Button>
          <Button
            variant="text"
            size="sm"
            onClick={onClear}
            style={{ padding: 6, borderRadius: 8, color: tokens.colors.text.tertiary }}
          >
            {t('clearAll')}
          </Button>
        </Box>
      </Box>

      {/* 交易员列表 */}
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {traders.map((trader) => (
          <Box
            key={trader.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 20,
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" weight="medium" style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {trader.handle || trader.id.slice(0, 8)}
            </Text>
            <button
              onClick={() => onRemove(trader.id)}
              aria-label={`${t('removeTrader')} ${trader.handle || trader.id}`}
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.colors.text.tertiary,
              }}
            >
              <X size={12} />
            </button>
          </Box>
        ))}
      </Box>

      {/* 快速对比按钮 */}
      <Link href={`/compare?ids=${traders.map(t => t.id).join(',')}`}>
        <Button
          variant="primary"
          size="sm"
          style={{ width: '100%' }}
        >
          {t('compareViewDetail')}
        </Button>
      </Link>
    </Box>
  )
}

function CompareDetailTable({ traders, onRemove }: { traders: Trader[]; onRemove: (id: string) => void }) {
  const { t } = useLanguage()
  const COMPARE_METRICS = useMemo(() => getCompareMetrics(t), [t])
  const [sortMetric, setSortMetric] = useState<keyof Trader>('roi')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  // 排序后的交易员
  const sortedTraders = useMemo(() => {
    return [...traders].sort((a, b) => {
      const aVal = a[sortMetric] as number || 0
      const bVal = b[sortMetric] as number || 0
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [traders, sortMetric, sortOrder])

  const handleSort = (key: keyof Trader) => {
    if (sortMetric === key) {
      setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')
    } else {
      setSortMetric(key)
      setSortOrder('desc')
    }
  }

  return (
    <Box className="compare-table-wrapper" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
        <thead>
          <tr>
            <th style={{
              padding: '12px 16px',
              textAlign: 'left',
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.tertiary,
              position: 'sticky',
              left: 0,
              zIndex: 1,
            }}>
              <Text size="xs" weight="bold" color="secondary">{t('trader')}</Text>
            </th>
            {COMPARE_METRICS.map(metric => (
              <th
                key={metric.key}
                onClick={() => handleSort(metric.key)}
                style={{
                  padding: '12px 16px',
                  textAlign: 'right',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.tertiary,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                  <Text size="xs" weight="bold" color="secondary">{metric.label}</Text>
                  {sortMetric === metric.key && (
                    sortOrder === 'desc'
                      ? <ChevronDown size={14} />
                      : <ChevronUp size={14} />
                  )}
                </Box>
              </th>
            ))}
            <th style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.tertiary,
              width: 40,
            }} />
          </tr>
        </thead>
        <tbody>
          {sortedTraders.map((trader, index) => {
            const isFirst = index === 0
            return (
              <tr
                key={trader.id}
                style={{
                  background: isFirst ? `${tokens.colors.accent?.primary || tokens.colors.accent.brand}10` : 'transparent',
                }}
              >
                <td style={{
                  padding: '12px 16px',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  position: 'sticky',
                  left: 0,
                  background: isFirst ? `${tokens.colors.accent?.primary || tokens.colors.accent.brand}10` : tokens.colors.bg.secondary,
                }}>
                  <Link href={`/trader/${trader.handle || trader.id}`} style={{ textDecoration: 'none' }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isFirst && (
                        <span style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                          color: tokens.colors.white,
                        }}>
                          TOP
                        </span>
                      )}
                      <Text size="sm" weight="medium" style={{ color: tokens.colors.text.primary }}>
                        {trader.handle || trader.id.slice(0, 12)}
                      </Text>
                    </Box>
                  </Link>
                </td>
                {COMPARE_METRICS.map(metric => {
                  const value = trader[metric.key] as number | undefined
                  const bestValue = getBestValue(traders, metric)
                  const isBest = value === bestValue && value != null

                  return (
                    <td
                      key={metric.key}
                      style={{
                        padding: '12px 16px',
                        textAlign: 'right',
                        borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {metric.colorize && <TrendIcon value={value} metric={metric} />}
                        <Text
                          size="sm"
                          weight={isBest ? 'bold' : 'medium'}
                          style={{
                            color: getValueColor(value, metric, bestValue),
                          }}
                        >
                          {metric.format(value)}
                        </Text>
                        {isBest && (
                          <span style={{
                            fontSize: 8,
                            padding: '1px 4px',
                            borderRadius: 3,
                            background: tokens.colors.accent?.success,
                            color: '#000',
                            fontWeight: 700,
                          }}>
                            BEST
                          </span>
                        )}
                      </Box>
                    </td>
                  )
                })}
                <td style={{
                  padding: '12px 16px',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}>
                  <button
                    onClick={() => onRemove(trader.id)}
                    aria-label={`${t('removeTrader')} ${trader.handle || trader.id}`}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: 'transparent',
                      border: `1px solid ${tokens.colors.border.primary}`,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tokens.colors.text.tertiary,
                    }}
                  >
                    <X size={14} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Box>
  )
}

function CompareTraders({ traders, onRemove, onClear, maxTraders = 5 }: CompareTradersProps) {
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(false)

  if (traders.length === 0) return null

  // 展开模式 - 显示详细对比
  if (isExpanded) {
    return (
      <Box
        role="dialog"
        aria-label={t('compareTraders')}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          left: 20,
          maxWidth: 1000,
          margin: '0 auto',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.4)',
          zIndex: tokens.zIndex.modal,
          overflow: 'hidden',
        }}
      >
        {/* 头部 */}
        <Box style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: 16,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
        }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <BarChart3 size={20} style={{ color: tokens.colors.accent?.primary || tokens.colors.accent.brand }} />
            <Text size="md" weight="bold">
              {t('compareTraders')} ({traders.length}/{maxTraders})
            </Text>
          </Box>
          <Box style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="text"
              size="sm"
              onClick={() => {
                // 复制分享链接
                const url = `${window.location.origin}/compare?ids=${traders.map(t => t.id).join(',')}`
                navigator.clipboard.writeText(url)
              }}
              aria-label={t('compareShare')}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Share2 size={16} />
              {t('compareShare')}
            </Button>
            <Button
              variant="text"
              size="sm"
              onClick={onClear}
              style={{ color: tokens.colors.text.tertiary }}
            >
              {t('clearAll')}
            </Button>
            <Button
              variant="text"
              size="sm"
              onClick={() => setIsExpanded(false)}
              aria-label={t('collapse')}
            >
              <ChevronDown size={20} />
            </Button>
          </Box>
        </Box>

        {/* 对比表格 */}
        <Box style={{ maxHeight: 400, overflow: 'auto' }}>
          <CompareDetailTable traders={traders} onRemove={onRemove} />
        </Box>

        {/* 底部操作 */}
        <Box style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: 12,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
        }}>
          <Link href={`/compare?ids=${traders.map(t => t.id).join(',')}`}>
            <Button variant="primary" size="sm">
              {t('compareViewFull')}
            </Button>
          </Link>
        </Box>
      </Box>
    )
  }

  // 收起模式 - 显示浮动条
  return (
    <CompareFloatingBar
      traders={traders}
      onRemove={onRemove}
      onClear={onClear}
      onExpand={() => setIsExpanded(true)}
    />
  )
}

export default memo(CompareTraders)
