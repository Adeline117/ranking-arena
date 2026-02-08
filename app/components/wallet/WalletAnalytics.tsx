'use client'

/**
 * WalletAnalytics - 综合钱包分析仪表盘
 * 包含: PnL 曲线图、胜率统计、平均持仓时间、最常交易代币、持仓分布
 * PnL 曲线使用 TradingView lightweight-charts
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import TokenDistribution from './TokenDistribution'
import type { WalletAnalyticsResult } from '@/lib/web3/wallet-analytics'
import { formatHoldTime } from '@/lib/web3/wallet-analytics'

interface WalletAnalyticsProps {
  address: string
  chainId?: number
}

function PnlChart({ data }: { data: Array<{ timestamp: number; cumulativePnl: number }> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof import('lightweight-charts').createChart> | null>(null)

  useEffect(() => {
    if (!containerRef.current || data.length < 2) return

    let disposed = false

    import('lightweight-charts').then(({ createChart, ColorType, AreaSeries }) => {
      if (disposed || !containerRef.current) return

      // 清除之前的图表
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 240,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: 'var(--color-text-secondary)',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: 'rgba(128,128,128,0.1)' },
          horzLines: { color: 'rgba(128,128,128,0.1)' },
        },
        rightPriceScale: {
          borderVisible: false,
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
        },
        crosshair: {
          horzLine: { visible: true, labelVisible: true },
          vertLine: { visible: true, labelVisible: true },
        },
      })

      const lastPnl = data[data.length - 1]?.cumulativePnl ?? 0
      const lineColor = lastPnl >= 0 ? '#22C55E' : '#EF4444'

      const series = chart.addSeries(AreaSeries, {
        lineColor,
        topColor: lastPnl >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
        bottomColor: 'transparent',
        lineWidth: 2,
      })

      series.setData(
        data.map((d) => ({
          time: d.timestamp as import('lightweight-charts').UTCTimestamp,
          value: d.cumulativePnl,
        }))
      )

      chart.timeScale().fitContent()
      chartRef.current = chart

      const observer = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.applyOptions({ width: containerRef.current.clientWidth })
        }
      })
      observer.observe(containerRef.current)

      return () => observer.disconnect()
    })

    return () => {
      disposed = true
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [data])

  if (data.length < 2) {
    return (
      <div style={{ color: tokens.colors.text.secondary, padding: tokens.spacing[4], textAlign: 'center' }}>
        交易数据不足，无法生成 PnL 曲线
      </div>
    )
  }

  return <div ref={containerRef} style={{ width: '100%', minHeight: '240px' }} />
}

function StatCard({ label, value, subValue, color }: {
  label: string
  value: string
  subValue?: string
  color?: string
}) {
  return (
    <div
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[4],
        flex: '1 1 160px',
        minWidth: '140px',
      }}
    >
      <div style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, marginBottom: tokens.spacing[1] }}>
        {label}
      </div>
      <div style={{ color: color ?? tokens.colors.text.primary, fontSize: tokens.typography.fontSize.xl, fontWeight: 700, fontFamily: 'monospace' }}>
        {value}
      </div>
      {subValue && (
        <div style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, marginTop: tokens.spacing[1] }}>
          {subValue}
        </div>
      )}
    </div>
  )
}

export default function WalletAnalytics({ address, chainId = 1 }: WalletAnalyticsProps) {
  const [analytics, setAnalytics] = useState<WalletAnalyticsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/wallet/${address}/pnl?chainId=${chainId}`)
      if (!res.ok) throw new Error('获取分析数据失败')
      const json = await res.json()
      setAnalytics(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [address, chainId])

  useEffect(() => {
    fetchAnalytics()
  }, [fetchAnalytics])

  if (loading) {
    return (
      <div style={{ color: tokens.colors.text.secondary, padding: tokens.spacing[6], textAlign: 'center' }}>
        正在分析钱包数据...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ color: tokens.colors.accent.error, padding: tokens.spacing[4] }}>
        {error}
      </div>
    )
  }

  if (!analytics) return null

  const pnlColor = analytics.totalPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const pnlPrefix = analytics.totalPnl >= 0 ? '+' : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      <h3 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg, fontWeight: 600, margin: 0 }}>
        钱包深度分析
      </h3>

      {/* 核心指标卡片 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
        <StatCard
          label="总盈亏 (PnL)"
          value={`${pnlPrefix}${analytics.totalPnl.toFixed(6)}`}
          subValue={`${analytics.closedTrades} 笔已平仓`}
          color={pnlColor}
        />
        <StatCard
          label="胜率"
          value={`${(analytics.winRate * 100).toFixed(1)}%`}
          subValue={`${analytics.profitableTrades}盈 / ${analytics.unprofitableTrades}亏`}
          color={analytics.winRate >= 0.5 ? tokens.colors.accent.success : tokens.colors.accent.warning}
        />
        <StatCard
          label="平均持仓时间"
          value={formatHoldTime(analytics.averageHoldTimeSeconds)}
          subValue={`${analytics.totalTrades} 笔总交易`}
        />
      </div>

      {/* PnL 曲线 */}
      <div
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          padding: tokens.spacing[4],
        }}
      >
        <h4 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.base, fontWeight: 600, margin: `0 0 ${tokens.spacing[3]} 0` }}>
          累积 PnL 曲线
        </h4>
        <PnlChart data={analytics.pnlCurve} />
      </div>

      {/* 持仓分布 */}
      {analytics.tokenDistribution.length > 0 && (
        <TokenDistribution data={analytics.tokenDistribution} />
      )}

      {/* 最常交易代币 */}
      {analytics.mostTradedTokens.length > 0 && (
        <div
          style={{
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            padding: tokens.spacing[4],
          }}
        >
          <h4 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.base, fontWeight: 600, margin: `0 0 ${tokens.spacing[3]} 0` }}>
            最常交易地址
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            {analytics.mostTradedTokens.map((t, i) => (
              <div
                key={t.address}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: `${tokens.spacing[2]} 0`,
                  borderBottom: i < analytics.mostTradedTokens.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <span style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, width: '20px' }}>
                    #{i + 1}
                  </span>
                  <span style={{ color: tokens.colors.text.primary, fontFamily: 'monospace', fontSize: tokens.typography.fontSize.sm }}>
                    {t.symbol}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacing[4], fontSize: tokens.typography.fontSize.xs }}>
                  <span style={{ color: tokens.colors.text.secondary }}>
                    {t.count} 笔
                  </span>
                  <span style={{ color: tokens.colors.text.primary, fontFamily: 'monospace' }}>
                    {t.totalVolume.toFixed(4)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
