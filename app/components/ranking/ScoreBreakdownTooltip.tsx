import React, { useState, useRef, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { Trader } from './RankingTable'

export const ScoreBreakdownTooltip = memo(function ScoreBreakdownTooltip({
  trader,
  language,
}: {
  trader: Trader
  language: string
}) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (trader.return_score == null && trader.drawdown_score == null && trader.stability_score == null) {
    return null
  }

  return (
    <div
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(s => !s) }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5, cursor: 'pointer' }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
      </svg>
      {show && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: 6,
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
          <div>{language === 'zh' ? '收益' : 'Return'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.return_score?.toFixed(1) ?? '—'}</span>/85</div>
          <div>{language === 'zh' ? '回撤' : 'Drawdown'}: <span style={{ color: tokens.colors.accent.warning, fontWeight: 700 }}>{trader.drawdown_score?.toFixed(1) ?? '—'}</span>/8</div>
          <div>{language === 'zh' ? '稳定' : 'Stability'}: <span style={{ color: tokens.colors.accent.primary, fontWeight: 700 }}>{trader.stability_score?.toFixed(1) ?? '—'}</span>/7</div>
        </div>
      )}
    </div>
  )
})
