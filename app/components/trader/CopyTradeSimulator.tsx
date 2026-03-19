'use client'

import { useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface EquityPoint {
  date: string
  roi: number
}

interface CopyTradeSimulatorProps {
  equityCurve: EquityPoint[]
}

export default function CopyTradeSimulator({ equityCurve }: CopyTradeSimulatorProps) {
  const { t } = useLanguage()
  const [investment, setInvestment] = useState(1000)
  const [startIdx, setStartIdx] = useState(0)

  const simulation = useMemo(() => {
    if (!equityCurve || equityCurve.length < 2) return null

    const startRoi = equityCurve[startIdx]?.roi ?? 0
    const endRoi = equityCurve[equityCurve.length - 1]?.roi ?? 0
    const returnPct = endRoi - startRoi
    const finalValue = investment * (1 + returnPct / 100)
    const profit = finalValue - investment

    // Build portfolio value curve from startIdx onward
    const portfolioCurve = equityCurve.slice(startIdx).map((point) => {
      const roiFromStart = point.roi - startRoi
      const value = investment * (1 + roiFromStart / 100)
      return { date: point.date, value }
    })

    return {
      finalValue,
      profit,
      returnPct,
      startDate: equityCurve[startIdx]?.date ?? '',
      endDate: equityCurve[equityCurve.length - 1]?.date ?? '',
      portfolioCurve,
    }
  }, [equityCurve, investment, startIdx])

  if (!equityCurve || equityCurve.length < 2) return null

  // Mini chart rendering via SVG
  const chartWidth = 320
  const chartHeight = 80

  let svgPath = ''
  if (simulation && simulation.portfolioCurve.length > 1) {
    const values = simulation.portfolioCurve.map((p) => p.value)
    const minVal = Math.min(...values)
    const maxVal = Math.max(...values)
    const range = maxVal - minVal || 1

    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * chartWidth
      const y = chartHeight - ((v - minVal) / range) * (chartHeight - 8) - 4
      return `${x},${y}`
    })
    svgPath = `M${points.join(' L')}`
  }

  const isPositive = (simulation?.profit ?? 0) >= 0

  return (
    <div
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[4] }}>
        {t('copyTradeSimulator') || 'Copy-Trade Simulator'}
      </div>

      {/* Inputs */}
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[4], flexWrap: 'wrap' }}>
        {/* Investment amount */}
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
            {t('investmentAmount') || 'Investment Amount'}
          </label>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 14, color: 'var(--color-text-tertiary)', pointerEvents: 'none',
            }}>$</span>
            <input
              type="number"
              value={investment}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                if (!isNaN(val) && val >= 0) setInvestment(val)
              }}
              min={0}
              step={100}
              style={{
                width: '100%',
                padding: '8px 10px 8px 24px',
                borderRadius: tokens.radius.md,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-primary)',
                fontSize: 14,
                fontWeight: 600,
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Start date slider */}
        <div style={{ flex: '2 1 200px' }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
            {t('startDate') || 'Start Date'}: {equityCurve[startIdx]?.date ?? ''}
          </label>
          <input
            type="range"
            min={0}
            max={Math.max(0, equityCurve.length - 2)}
            value={startIdx}
            onChange={(e) => setStartIdx(parseInt(e.target.value, 10))}
            style={{
              width: '100%',
              accentColor: 'var(--color-brand)',
              cursor: 'pointer',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            <span>{equityCurve[0]?.date}</span>
            <span>{equityCurve[equityCurve.length - 1]?.date}</span>
          </div>
        </div>
      </div>

      {/* Result */}
      {simulation && (
        <div style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          background: isPositive ? 'rgba(47, 229, 125, 0.06)' : 'rgba(255, 124, 124, 0.06)',
          border: `1px solid ${isPositive ? 'rgba(47, 229, 125, 0.2)' : 'rgba(255, 124, 124, 0.2)'}`,
          marginBottom: tokens.spacing[4],
        }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
            {(t('copyTradeResult') || 'If you invested ${amount} on {date}, you would have:')
              .replace('${amount}', `$${investment.toLocaleString()}`)
              .replace('{date}', simulation.startDate)}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 28,
              fontWeight: 800,
              color: isPositive ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
            }}>
              ${simulation.finalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span style={{
              fontSize: 14,
              fontWeight: 600,
              color: isPositive ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
            }}>
              {isPositive ? '+' : ''}{simulation.profit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              {' '}({isPositive ? '+' : ''}{simulation.returnPct.toFixed(1)}%)
            </span>
          </div>
        </div>
      )}

      {/* Mini SVG Chart */}
      {svgPath && (
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          width="100%"
          height={chartHeight}
          style={{ display: 'block' }}
          preserveAspectRatio="none"
        >
          {/* Gradient fill */}
          <defs>
            <linearGradient id="simGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isPositive ? 'rgba(47, 229, 125, 0.3)' : 'rgba(255, 124, 124, 0.3)'} />
              <stop offset="100%" stopColor="transparent" />
            </linearGradient>
          </defs>
          {/* Area */}
          <path
            d={`${svgPath} L${chartWidth},${chartHeight} L0,${chartHeight} Z`}
            fill="url(#simGradient)"
          />
          {/* Line */}
          <path
            d={svgPath}
            fill="none"
            stroke={isPositive ? 'var(--color-accent-success)' : 'var(--color-accent-error)'}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* Disclaimer */}
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: tokens.spacing[2], lineHeight: 1.4 }}>
        {t('copyTradeDisclaimer') || 'Simulated returns based on historical ROI. Past performance does not guarantee future results. Does not account for fees, slippage, or liquidation risk.'}
      </div>
    </div>
  )
}
