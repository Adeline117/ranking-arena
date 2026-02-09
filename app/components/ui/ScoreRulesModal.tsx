'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import { Text } from '../base'

interface ScoreRulesModalProps {
  isOpen: boolean
  onClose: () => void
}

export function ScoreRulesModal({ isOpen, onClose }: ScoreRulesModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const previousFocus = document.activeElement as HTMLElement
    
    // Focus the modal after render
    const focusTimer = setTimeout(() => {
      if (modalRef.current) {
        const firstBtn = modalRef.current.querySelector<HTMLElement>('button')
        firstBtn?.focus()
      }
    }, 50)
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      // Focus trap
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    }
    
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
      previousFocus?.focus()
    }
  }, [isOpen, onClose])

  if (!isOpen || !mounted) return null

  const modalContent = (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-backdrop-heavy)',
        backdropFilter: tokens.glass.blur.sm,
        WebkitBackdropFilter: tokens.glass.blur.sm,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: tokens.zIndex.modal,
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="score-rules-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 580,
          maxHeight: '85vh',
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.xl,
          WebkitBackdropFilter: tokens.glass.blur.xl,
          border: tokens.glass.border.medium,
          borderRadius: tokens.radius['2xl'],
          overflow: 'hidden',
          boxShadow: `${tokens.shadow.xl}, 0 0 80px var(--color-accent-primary-15)`,
          animation: 'scaleIn 0.2s ease-out',
        }}
      >
        {/* Header gradient */}
        <div style={{ height: 4, background: tokens.gradient.primary }} />

        {/* Title bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text id="score-rules-modal-title" size="lg" weight="bold" style={{ color: tokens.colors.text.primary }}>
            Arena Score Methodology
          </Text>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32,
              height: 32,
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: tokens.glass.bg.light,
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              transition: tokens.transition.base,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.glass.bg.medium
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = tokens.glass.bg.light
              e.currentTarget.style.color = tokens.colors.text.secondary
            }}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: tokens.spacing[5],
            overflowY: 'auto',
            maxHeight: 'calc(85vh - 60px)',
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.8,
            color: tokens.colors.text.secondary,
          }}
        >
          {/* Score Composition */}
          <Section title={t('scoreComposition')} accent>
            <FormulaBox>
              S<sub>total</sub> = S<sub>return</sub> + S<sub>pnl</sub> + S<sub>dd</sub> + S<sub>stab</sub>
            </FormulaBox>
            <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <ScoreBadge label={t('returnScoreLabel')} value="[0, 70]" color={tokens.colors.accent.success} />
              <ScoreBadge label={t('pnlScoreLabel')} value="[0, 15]" color={tokens.colors.accent.brand} />
              <ScoreBadge label={t('drawdownLabel')} value="[0, 8]" color={tokens.colors.accent.warning} />
              <ScoreBadge label={t('stabilityLabel')} value="[0, 7]" color={tokens.colors.accent.primary} />
              <ScoreBadge label={t('totalLabel')} value="[0, 100]" color={tokens.colors.accent.warning} />
            </div>
          </Section>

          {/* Return Score */}
          <Section title={t('returnScoreTitle')}>
            <div style={{ marginBottom: 12, color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('annualizedRoiDesc')}
            </div>
            <FormulaBox>
              <div style={{ marginBottom: 8 }}>
                I<sub>d</sub> = (365 / d) · ln(1 + ROI<sub>d</sub>)
              </div>
              <div>
                S<sub>return</sub> = 70 · tanh(α · I<sub>d</sub>)<sup>β</sup>
              </div>
            </FormulaBox>
            <div style={{ marginTop: 12 }}>
              <ParamTable
                headers={[t('periodHeader'), t('coeffHeader'), t('expHeader')]}
                rows={[
                  ['7D', '0.08', '1.8'],
                  ['30D', '0.15', '1.6'],
                  ['90D', '0.18', '1.6'],
                ]}
              />
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
              {t('periodDaysNote')}
            </div>
          </Section>

          {/* PnL Score */}
          <Section title={t('pnlScoreTitle')}>
            <div style={{ marginBottom: 12, color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('absoluteProfitDesc')}
            </div>
            <FormulaBox>
              S<sub>pnl</sub> = 15 · tanh(γ · ln(1 + PnL / base))
            </FormulaBox>
            <div style={{ marginTop: 12 }}>
              <ParamTable
                headers={[t('periodHeader'), t('baseHeader'), 'γ (coeff)']}
                rows={[
                  ['7D', '500', '0.40'],
                  ['30D', '2,000', '0.35'],
                  ['90D', '5,000', '0.30'],
                ]}
              />
            </div>
          </Section>

          {/* Risk Score */}
          <Section title={t('riskScoreTitle')}>
            <div style={{ marginBottom: 16 }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: 8, display: 'block' }}>
                {t('drawdownComponent')}
              </Text>
              <FormulaBox small>
                S<sub>dd</sub> = 8 · max(0, 1 − MDD / θ<sub>d</sub>)
              </FormulaBox>
              <div style={{ marginTop: 8 }}>
                <ParamTable 
                  headers={[t('periodHeader'), t('thresholdHeader')]}
                  rows={[
                    ['7D', '15%'],
                    ['30D', '30%'],
                    ['90D', '40%'],
                  ]}
                  compact
                />
              </div>
            </div>
            
            <div>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: 8, display: 'block' }}>
                {t('stabilityComponent')}
              </Text>
              <FormulaBox small>
                S<sub>stab</sub> = 7 · clip((WR − 0.45) / (γ<sub>d</sub> − 0.45), 0, 1)
              </FormulaBox>
              <div style={{ marginTop: 8 }}>
                <ParamTable 
                  headers={[t('periodHeader'), t('winRateCapHeader')]}
                  rows={[
                    ['7D', '62%'],
                    ['30D', '68%'],
                    ['90D', '70%'],
                  ]}
                  compact
                />
              </div>
            </div>
          </Section>

          {/* Ranking Logic */}
          <Section title={t('rankingLogicTitle')}>
            <FormulaBox small>
              <div>{t('primarySortDesc')}<sub>total</sub>{t('primarySortSuffix')}</div>
              <div style={{ marginTop: 4 }}>{t('secondarySortDesc')}</div>
            </FormulaBox>
          </Section>

          {/* Score Distribution */}
          <Section title={t('scoreDistTitle')} last>
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: 8,
              background: tokens.glass.bg.light,
              padding: 12,
              borderRadius: tokens.radius.lg,
            }}>
              <ScoreRange range="30-40" description={t('medianPerformers')} />
              <ScoreRange range="50-60" description={t('aboveAverage')} highlight />
              <ScoreRange range="60-80" description={t('topQuartile')} highlight />
              <ScoreRange range="80+" description={t('elitePerformers')} gold />
            </div>
          </Section>
        </div>
      </div>
    </div>
  )

  return createPortal(modalContent, document.body)
}

// Helper components
function Section({ 
  title, 
  children, 
  accent = false,
  last = false,
}: { 
  title: string
  children: React.ReactNode
  accent?: boolean
  last?: boolean
}) {
  return (
    <div style={{ 
      marginBottom: last ? 0 : 20,
      paddingBottom: last ? 0 : 20,
      borderBottom: last ? 'none' : `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Text 
        size="md" 
        weight="bold" 
        style={{ 
          color: accent ? tokens.colors.accent.primary : tokens.colors.text.primary,
          marginBottom: 12,
          display: 'block',
        }}
      >
        {title}
      </Text>
      {children}
    </div>
  )
}

function FormulaBox({ 
  children, 
  small = false 
}: { 
  children: React.ReactNode
  small?: boolean 
}) {
  return (
    <div style={{
      background: 'var(--color-accent-primary-10)',
      border: `1px solid ${tokens.colors.accent.primary}30`,
      borderRadius: tokens.radius.lg,
      padding: small ? '10px 14px' : '14px 18px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: small ? 13 : 14,
      color: tokens.colors.text.primary,
      letterSpacing: '0.02em',
    }}>
      {children}
    </div>
  )
}

function ScoreBadge({ 
  label, 
  value, 
  color 
}: { 
  label: string
  value: string
  color: string 
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: `${color}15`,
      border: `1px solid ${color}30`,
      borderRadius: tokens.radius.md,
      padding: '4px 10px',
      fontSize: 12,
    }}>
      <span style={{ color: tokens.colors.text.secondary }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )
}

function ParamTable({ 
  headers, 
  rows,
  compact = false,
}: { 
  headers: string[]
  rows: string[][]
  compact?: boolean
}) {
  return (
    <div style={{
      background: tokens.glass.bg.light,
      borderRadius: tokens.radius.md,
      overflow: 'hidden',
      fontSize: compact ? 11 : 12,
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
        background: tokens.glass.bg.medium,
        padding: compact ? '6px 10px' : '8px 12px',
        fontWeight: 600,
        color: tokens.colors.text.tertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        fontSize: compact ? 10 : 11,
      }}>
        {headers.map((h, i) => (
          <div key={i}>{h}</div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
          padding: compact ? '6px 10px' : '8px 12px',
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          color: tokens.colors.text.secondary,
        }}>
          {row.map((cell, j) => (
            <div key={j} style={{ fontFamily: j > 0 ? 'monospace' : 'inherit' }}>{cell}</div>
          ))}
        </div>
      ))}
    </div>
  )
}

function ScoreRange({ 
  range, 
  description, 
  highlight = false,
  gold = false,
}: { 
  range: string
  description: string
  highlight?: boolean
  gold?: boolean
}) {
  const color = gold 
    ? tokens.colors.medal.gold 
    : highlight 
      ? tokens.colors.accent.success 
      : tokens.colors.text.secondary

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'space-between',
      alignItems: 'center',
    }}>
      <span style={{ 
        fontWeight: 600, 
        color,
        fontFamily: 'ui-monospace, monospace',
      }}>
        {range}
      </span>
      <span style={{ color: tokens.colors.text.tertiary, fontSize: 12 }}>
        {description}
      </span>
    </div>
  )
}

export default ScoreRulesModal
