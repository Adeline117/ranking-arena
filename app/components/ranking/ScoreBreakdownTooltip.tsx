import React, { useState, useRef, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from './RankingTable'

/**
 * 置信度标签配置
 */
const CONFIDENCE_LABELS: Record<
  string,
  {
    i18nKey: 'scoreConfidencePartial' | 'scoreConfidenceMinimal'
    color: string
    icon: string
    penalty: string
  }
> = {
  partial: {
    i18nKey: 'scoreConfidencePartial',
    color: tokens.colors.accent.warning,
    icon: '!',
    penalty: '-8%',
  },
  minimal: {
    i18nKey: 'scoreConfidenceMinimal',
    color: tokens.colors.accent.error ?? tokens.colors.accent.warning,
    icon: '!',
    penalty: '-20%',
  },
}

export const ScoreBreakdownTooltip = memo(function ScoreBreakdownTooltip({
  trader,
  language: _language,
}: {
  trader: Trader
  language: string
}) {
  const { t } = useLanguage()
  const [show, setShow] = useState(false)
  const [positioned, setPositioned] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Click-outside: close tooltip when clicking outside
  useEffect(() => {
    if (!show) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        tooltipRef.current &&
        !tooltipRef.current.contains(e.target as Node)
      ) {
        setShow(false)
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [show])

  // Reset positioned state when tooltip closes
  useEffect(() => {
    if (!show) setPositioned(false)
  }, [show])

  // Calculate fixed position relative to viewport
  useEffect(() => {
    if (!show || !ref.current || !tooltipRef.current) return

    const triggerRect = ref.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()

    // Vertical: prefer above trigger, flip to below if not enough space
    let top: number
    if (triggerRect.top < tooltipRect.height + 10) {
      top = triggerRect.bottom + 6
    } else {
      top = triggerRect.top - tooltipRect.height - 6
    }
    // Clamp to viewport
    if (top + tooltipRect.height > window.innerHeight - 8) {
      top = triggerRect.top - tooltipRect.height - 6
    }
    if (top < 8) top = 8

    // Horizontal: center on trigger, constrain to viewport edges
    let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8))

    setTooltipPos({ top, left })
    setPositioned(true)
  }, [show])

  // v4: gate on the flagship sub-scores (profitability/risk/execution). Fall back
  // to arena_score so the breakdown still shows when only the composite is present.
  if (
    trader.profitability_score == null &&
    trader.risk_control_score == null &&
    trader.execution_score == null &&
    trader.arena_score == null
  ) {
    return null
  }

  // Raw metric formatters for the dimension inputs shown under the sub-scores.
  const fmtPct = (v: number | null | undefined) =>
    v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
  const fmtUsd = (v: number | null | undefined) =>
    v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`
  const fmtNum = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))

  // Derive confidence from data if API didn't provide it
  // Use == null instead of falsy check: win_rate=0 and max_drawdown=0 are valid values
  const confidence =
    trader.score_confidence ??
    (trader.win_rate == null && trader.max_drawdown == null
      ? 'minimal'
      : trader.win_rate == null || trader.max_drawdown == null
        ? 'partial'
        : 'full')
  const confidenceInfo = confidence !== 'full' ? CONFIDENCE_LABELS[confidence] : null

  // Tooltip content rendered via portal to escape overflow:hidden + backdropFilter
  // containers (e.g. ranking table glass card) that break position:fixed
  const tooltipContent = show ? (
    <div
      ref={tooltipRef}
      style={{
        position: 'fixed',
        top: tooltipPos.top,
        left: tooltipPos.left,
        visibility: positioned ? 'visible' : 'hidden',
        padding: '8px 12px',
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        boxShadow: tokens.shadow.lg,
        zIndex: tokens.zIndex.tooltip,
        whiteSpace: 'nowrap',
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.6,
        color: tokens.colors.text.secondary,
        pointerEvents: 'none',
      }}
    >
      {/* v4 (2026-07): flagship dimensions are 盈利 / 风控 / 一致性 (each 0-100
          percentile), NOT the retired V3 ReturnScore/PnlScore/70-15-8-7 scale. */}
      <div style={{ fontWeight: 700, marginBottom: 2, color: tokens.colors.text.primary }}>
        {t('scoreBreakdownLabel')}
      </div>
      <div>
        {t('scoreProfit')}:{' '}
        <span style={{ color: 'var(--color-score-profitability)', fontWeight: 700 }}>
          {trader.profitability_score?.toFixed(0) ?? '—'}
        </span>
        /100
      </div>
      <div>
        {t('scoreRisk')}:{' '}
        <span style={{ color: 'var(--color-score-risk)', fontWeight: 700 }}>
          {trader.risk_control_score?.toFixed(0) ?? '—'}
        </span>
        /100
      </div>
      <div>
        {t('scoreExecution')}:{' '}
        <span style={{ color: 'var(--color-score-execution)', fontWeight: 700 }}>
          {trader.execution_score?.toFixed(0) ?? '—'}
        </span>
        /100
      </div>
      {/* The real dimension inputs behind the sub-scores */}
      <div
        style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.xs,
          whiteSpace: 'normal',
          maxWidth: 240,
          lineHeight: 1.7,
        }}
      >
        {t('roi')} {fmtPct(trader.roi)} · {t('pnl')} {fmtUsd(trader.pnl)} · {t('scoreDrawdown')}{' '}
        {fmtPct(trader.max_drawdown != null ? -Math.abs(trader.max_drawdown) : null)} · Sharpe{' '}
        {fmtNum(trader.sharpe_ratio)} · {t('winRate')} {fmtPct(trader.win_rate)}
      </div>
      {confidenceInfo && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 4,
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            color: confidenceInfo.color,
            fontSize: tokens.typography.fontSize.xs,
            whiteSpace: 'normal',
            maxWidth: 220,
          }}
        >
          {t(confidenceInfo.i18nKey)}
          {/* Show which fields are missing */}
          <div
            style={{
              marginTop: 2,
              opacity: 0.8,
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
            }}
          >
            {t('scoreConfidenceMissing')}
            {[
              trader.win_rate == null && t('scoreConfidenceWinRate'),
              trader.max_drawdown == null && t('scoreConfidenceDrawdown'),
            ]
              .filter(Boolean)
              .join(', ')}
          </div>
        </div>
      )}
      {/* Link the full methodology from where users actually inspect a score. */}
      <a
        href="/methodology"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'block',
          marginTop: 6,
          paddingTop: 6,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.semibold,
          color: 'var(--color-accent-primary)',
          textDecoration: 'none',
        }}
      >
        {t('heroHowRanked')}
      </a>
    </div>
  ) : null

  return (
    <div
      ref={ref}
      className="score-tooltip-trigger score-tooltip-hit-target"
      role="button"
      tabIndex={0}
      aria-label={t('scoreBreakdownLabel')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setShow((s) => !s)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setShow((s) => !s)
        }
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
        style={{
          opacity: confidenceInfo ? 0.8 : 0.5,
          cursor: 'pointer',
          color: confidenceInfo ? confidenceInfo.color : 'currentColor',
        }}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
      </svg>
      {typeof document !== 'undefined' && tooltipContent
        ? createPortal(tooltipContent, document.body)
        : null}
    </div>
  )
})
