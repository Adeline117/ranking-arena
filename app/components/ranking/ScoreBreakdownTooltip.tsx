import React, { useState, useRef, useEffect, useCallback, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { Trader } from './RankingTable'

/**
 * 置信度标签配置
 */
const CONFIDENCE_LABELS: Record<string, { zh: string; en: string; color: string; icon: string }> = {
  partial: {
    zh: '⚠ 部分数据缺失，使用了默认中位值',
    en: '⚠ Partial data — defaults used for some metrics',
    color: tokens.colors.accent.warning,
    icon: '⚠',
  },
  minimal: {
    zh: '⚠ 数据不完整，回撤与胜率均使用默认值',
    en: '⚠ Incomplete data — drawdown & win rate are defaults',
    color: tokens.colors.accent.error ?? tokens.colors.accent.warning,
    icon: '⚠',
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
  const [flipToBottom, setFlipToBottom] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Click-outside: close tooltip when clicking outside
  useEffect(() => {
    if (!show) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShow(false)
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [show])

  // Viewport detection: flip tooltip direction if not enough space above
  const checkPosition = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    // Tooltip is ~160px tall; flip to bottom if less than 170px above trigger
    setFlipToBottom(rect.top < 170)
  }, [])

  useEffect(() => {
    if (show) checkPosition()
  }, [show, checkPosition])

  if (trader.return_score == null && trader.pnl_score == null && trader.drawdown_score == null && trader.stability_score == null) {
    return null
  }

  const confidence = trader.score_confidence
  const confidenceInfo = confidence && confidence !== 'full'
    ? CONFIDENCE_LABELS[confidence]
    : null

  const positionStyle: React.CSSProperties = flipToBottom
    ? { top: '100%', marginTop: 6 }
    : { bottom: '100%', marginBottom: 6 }

  return (
    <div
      ref={ref}
      className="score-tooltip-trigger"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(s => !s) }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: confidenceInfo ? 0.8 : 0.5, cursor: 'pointer', color: confidenceInfo ? confidenceInfo.color : 'currentColor' }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
      </svg>
      <div
        ref={tooltipRef}
        className={`score-tooltip-content${show ? ' score-tooltip-visible' : ''}`}
        style={{
            position: 'absolute',
            ...positionStyle,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 12px',
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.lg,
            zIndex: 100,
            whiteSpace: 'nowrap',
            fontSize: '11px',
            lineHeight: 1.6,
            color: tokens.colors.text.secondary,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2, color: tokens.colors.text.primary }}>
            {language === 'zh' ? '分数构成' : 'Score Breakdown'}
          </div>
          <div>{language === 'zh' ? '收益' : 'Return'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.return_score?.toFixed(1) ?? '—'}</span>/70</div>
          <div>{language === 'zh' ? '盈亏' : 'PnL'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.pnl_score?.toFixed(1) ?? '—'}</span>/15</div>
          <div>
            {language === 'zh' ? '回撤' : 'Drawdown'}: <span style={{ color: tokens.colors.accent.warning, fontWeight: 700 }}>{trader.drawdown_score?.toFixed(1) ?? '—'}</span>/8
            {trader.max_drawdown == null && <span style={{ opacity: 0.6, fontSize: '10px' }}> *</span>}
          </div>
          <div>
            {language === 'zh' ? '稳定' : 'Stability'}: <span style={{ color: tokens.colors.accent.primary, fontWeight: 700 }}>{trader.stability_score?.toFixed(1) ?? '—'}</span>/7
            {trader.win_rate == null && <span style={{ opacity: 0.6, fontSize: '10px' }}> *</span>}
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
            </div>
          )}
        </div>
    </div>
  )
})
