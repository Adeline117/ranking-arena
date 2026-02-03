import React, { useState, useRef, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import type { Trader } from './RankingTable'

/**
 * 置信度标签配置
 */
const CONFIDENCE_LABELS: Record<string, { zh: string; en: string; color: string; icon: string; penalty: string }> = {
  partial: {
    zh: '⚠ 部分数据缺失（分数 ×0.92）',
    en: '⚠ Partial data — score ×0.92',
    color: tokens.colors.accent.warning,
    icon: '⚠',
    penalty: '-8%',
  },
  minimal: {
    zh: '⚠ 胜率和回撤均缺失（分数 ×0.80）',
    en: '⚠ Win rate & drawdown missing — score ×0.80',
    color: tokens.colors.accent.error ?? tokens.colors.accent.warning,
    icon: '⚠',
    penalty: '-20%',
  },
}

export const ScoreBreakdownTooltip = memo(function ScoreBreakdownTooltip({
  trader,
  language,
}: {
  trader: Trader
  language: string
}) {
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
        ref.current && !ref.current.contains(e.target as Node) &&
        tooltipRef.current && !tooltipRef.current.contains(e.target as Node)
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

  if (trader.return_score == null && trader.pnl_score == null && trader.drawdown_score == null && trader.stability_score == null) {
    return null
  }

  // Derive confidence from data if API didn't provide it
  const confidence = trader.score_confidence ?? (
    (!trader.win_rate) && (!trader.max_drawdown) ? 'minimal' :
    (!trader.win_rate) || (!trader.max_drawdown) ? 'partial' :
    'full'
  )
  const confidenceInfo = confidence !== 'full'
    ? CONFIDENCE_LABELS[confidence]
    : null

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
        fontSize: '11px',
        lineHeight: 1.6,
        color: tokens.colors.text.secondary,
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 2, color: tokens.colors.text.primary }}>
        {language === 'zh' ? '分数构成' : 'Score Breakdown'}
      </div>
      <div>{language === 'zh' ? '收益' : 'Return'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.return_score?.toFixed(1) ?? '—'}</span>/70</div>
      <div>{language === 'zh' ? '盈亏' : 'PnL'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.pnl_score?.toFixed(1) ?? '—'}</span>/15</div>
      <div>
        {language === 'zh' ? '回撤' : 'Drawdown'}: <span style={{ color: tokens.colors.accent.warning, fontWeight: 700 }}>{trader.drawdown_score?.toFixed(1) ?? '—'}</span>/8
        {!trader.max_drawdown && <span style={{ opacity: 0.6, fontSize: '10px' }}> *</span>}
      </div>
      <div>
        {language === 'zh' ? '稳定' : 'Stability'}: <span style={{ color: tokens.colors.accent.primary, fontWeight: 700 }}>{trader.stability_score?.toFixed(1) ?? '—'}</span>/7
        {!trader.win_rate && <span style={{ opacity: 0.6, fontSize: '10px' }}> *</span>}
      </div>
      {confidenceInfo && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 4,
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            color: confidenceInfo.color,
            fontSize: '10px',
            whiteSpace: 'normal',
            maxWidth: 220,
          }}
        >
          {language === 'zh' ? confidenceInfo.zh : confidenceInfo.en}
          {/* Show which fields are missing */}
          <div style={{ marginTop: 2, opacity: 0.8, fontSize: '9px', color: tokens.colors.text.tertiary }}>
            {language === 'zh' ? '缺失: ' : 'Missing: '}
            {[
              !trader.win_rate && (language === 'zh' ? '胜率' : 'Win Rate'),
              !trader.max_drawdown && (language === 'zh' ? '回撤' : 'Drawdown'),
            ].filter(Boolean).join(', ')}
          </div>
        </div>
      )}
    </div>
  ) : null

  return (
    <div
      ref={ref}
      className="score-tooltip-trigger"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(s => !s) }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: confidenceInfo ? 0.8 : 0.5, cursor: 'pointer', color: confidenceInfo ? confidenceInfo.color : 'currentColor' }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
      </svg>
      {typeof document !== 'undefined' && tooltipContent
        ? createPortal(tooltipContent, document.body)
        : null}
    </div>
  )
})
