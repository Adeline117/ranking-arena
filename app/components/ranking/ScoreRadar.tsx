'use client'

import React, { memo } from 'react'
import { getScoreColor } from '@/lib/utils/score-colors'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ScoreRadarProps {
  profitability: number | null // 0-100 (v4: 盈利维度 = PnL+ROI 百分位)
  riskControl: number | null // 0-100 (v4: 风控维度 = 回撤+Sharpe 百分位)
  /** @deprecated V3 removed the execution axis; v4 exposes consistency via the
   *  breakdown bars instead. Accepted for backwards-compat, not rendered. */
  execution?: number | null
  arenaScore: number // 0-100, for color
  size?: number
}

/**
 * 雷达图 - SVG自绘
 * 两个轴：盈利能力、风险控制 —— v4 起均为 0-100 维度百分位
 * (旧 60/40 标尺是 V3 的 ReturnScore/PnlScore,已随 v4 切换废弃)。
 */
export const ScoreRadar = memo(function ScoreRadar({
  profitability,
  riskControl,
  arenaScore,
  size = 120,
}: ScoreRadarProps) {
  const { t } = useLanguage()
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.38 // max radius

  // Normalize to 0-1: both axes are 0-100 v4 dimension percentiles; guard null/NaN.
  const pFinite = profitability != null && Number.isFinite(profitability)
  const rFinite = riskControl != null && Number.isFinite(riskControl)
  const pVal = pFinite ? (profitability as number) : 0
  const rVal = rFinite ? (riskControl as number) : 0
  const pNorm = Math.min(Math.max(pVal / 100, 0), 1)
  const rNorm = Math.min(Math.max(rVal / 100, 0), 1)

  // Two axes: profit (upper-left) and risk (upper-right), symmetric about the
  // vertical so the filled shape reads as a balanced "peak".
  const angles = [(-Math.PI * 3) / 4, -Math.PI / 4]

  const getPoint = (angle: number, ratio: number) => ({
    x: cx + r * ratio * Math.cos(angle),
    y: cy + r * ratio * Math.sin(angle),
  })

  // Background grid (nested triangles from center to each axis tip)
  const gridLevels = [0.33, 0.66, 1.0]
  const gridPaths = gridLevels.map((level) => {
    const a = getPoint(angles[0], level)
    const b = getPoint(angles[1], level)
    return `M${cx},${cy} L${a.x},${a.y} L${b.x},${b.y} Z`
  })

  // Axis lines
  const axisLines = angles.map((a) => {
    const end = getPoint(a, 1)
    return `M${cx},${cy} L${end.x},${end.y}`
  })

  // Data shape (center → profit → risk → center). Floor ratio so a zero axis
  // still shows a small dot rather than collapsing onto the center.
  const values = [pNorm, rNorm]
  const dataPoints = angles.map((a, i) => getPoint(a, Math.max(values[i], 0.05)))
  const dataPath = `M${cx},${cy} L${dataPoints[0].x},${dataPoints[0].y} L${dataPoints[1].x},${dataPoints[1].y} Z`

  const color = getScoreColor(arenaScore)
  const labelFontSize = Math.max(size * 0.08, 9)
  // Raw per-axis scores for on-data value labels.
  const rawValues = [pVal, rVal]
  const rawFinite = [pFinite, rFinite]
  const valueFontSize = Math.max(size * 0.062, 8)

  // Label positions (slightly outside the shape)
  const labelOffset = r + 14
  const labels = [
    {
      text: t('scoreRadarProfit'),
      x: cx + labelOffset * Math.cos(angles[0]) - 2,
      y: cy + labelOffset * Math.sin(angles[0]) - 2,
    },
    {
      text: t('scoreRadarRisk'),
      x: cx + labelOffset * Math.cos(angles[1]) + 2,
      y: cy + labelOffset * Math.sin(angles[1]) - 2,
    },
  ]

  // Honest accessible summary: both axes 0-100 (v4 percentiles), null-guarded,
  // no deprecated Exec axis.
  const ariaProfit = pFinite ? Math.round(pVal) : '—'
  const ariaRisk = rFinite ? Math.round(rVal) : '—'
  const ariaLabel =
    `Score radar: ${t('scoreRadarProfit')} ${ariaProfit}/100, ` +
    `${t('scoreRadarRisk')} ${ariaRisk}/100`

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
      style={{ overflow: 'visible' }}
    >
      {/* Grid */}
      {gridPaths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="var(--color-border-secondary)"
          strokeWidth={0.5}
          opacity={0.5}
        />
      ))}
      {/* Axes */}
      {axisLines.map((d, i) => (
        <path
          key={`axis-${i}`}
          d={d}
          stroke="var(--color-border-secondary)"
          strokeWidth={0.5}
          opacity={0.4}
        />
      ))}
      {/* Data fill */}
      <path d={dataPath} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.5} />
      {/* Data points */}
      {dataPoints.map((pt, i) => (
        <circle key={`pt-${i}`} cx={pt.x} cy={pt.y} r={2.5} fill={color} />
      ))}
      {/* On-data value labels — score read directly off each axis dot. Nudged
          radially outward so they clear the filled polygon. */}
      {dataPoints.map((pt, i) =>
        rawFinite[i] ? (
          <text
            key={`val-${i}`}
            x={pt.x + Math.cos(angles[i]) * 8}
            y={pt.y + Math.sin(angles[i]) * 8}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={color}
            fontSize={valueFontSize}
            fontWeight={700}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {Math.round(rawValues[i])}
          </text>
        ) : null
      )}
      {/* Labels */}
      {labels.map((l, i) => (
        <text
          key={`label-${i}`}
          x={l.x}
          y={l.y}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text-tertiary)"
          fontSize={labelFontSize}
          fontWeight={600}
        >
          {l.text}
        </text>
      ))}
    </svg>
  )
})

export default ScoreRadar
