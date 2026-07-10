'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokens, alpha } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
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

  useModalA11y({ open: isOpen, onClose, modalRef })

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
          <Text
            id="score-rules-modal-title"
            size="lg"
            weight="bold"
            style={{ color: tokens.colors.text.primary }}
          >
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
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
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
          {/* Score Composition — v4: Score = 100 × Quality × Confidence */}
          <Section title={t('scoreComposition')} accent>
            <FormulaBox>{t('scoreV4Formula')}</FormulaBox>
            <div style={{ marginTop: 12, color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('scoreV4Intro')}
            </div>
          </Section>

          {/* Quality — five weighted dimensions */}
          <Section title={t('scoreV4QualityTitle')}>
            <div style={{ marginBottom: 12, color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('scoreV4QualityDesc')}
            </div>
            <ParamTable
              headers={[t('scoreV4DimHeader'), t('scoreV4WeightHeader')]}
              rows={[
                [t('scoreV4DimPnl'), '0.30'],
                [t('scoreV4DimRoi'), '0.20'],
                [t('scoreV4DimDrawdown'), '0.20'],
                [t('scoreV4DimSharpe'), '0.20'],
                [t('scoreV4DimConsistency'), '0.10'],
              ]}
            />
          </Section>

          {/* Confidence */}
          <Section title={t('scoreV4ConfidenceTitle')}>
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('scoreV4ConfidenceDesc')}
            </div>
          </Section>

          {/* Displayed score */}
          <Section title={t('scoreV4DisplayTitle')}>
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 12 }}>
              {t('scoreV4DisplayDesc')}
            </div>
          </Section>

          {/* Anti-gaming */}
          <Section title={t('scoreV4AntiGamingTitle')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {t('scoreV4AntiGaming')
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, i) => (
                  <div key={i} style={{ color: tokens.colors.text.secondary, fontSize: 12 }}>
                    • {line}
                  </div>
                ))}
            </div>
          </Section>

          {/* Score Distribution */}
          <Section title={t('scoreDistTitle')} last>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: tokens.glass.bg.light,
                padding: 12,
                borderRadius: tokens.radius.lg,
              }}
            >
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
    <div
      style={{
        marginBottom: last ? 0 : 20,
        paddingBottom: last ? 0 : 20,
        borderBottom: last ? 'none' : `1px solid ${tokens.colors.border.primary}`,
      }}
    >
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

function FormulaBox({ children, small = false }: { children: React.ReactNode; small?: boolean }) {
  return (
    <div
      style={{
        background: 'var(--color-accent-primary-10)',
        border: `1px solid ${alpha(tokens.colors.accent.primary, 19)}`,
        borderRadius: tokens.radius.lg,
        padding: small ? '10px 14px' : '14px 18px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: small ? 13 : 14,
        color: tokens.colors.text.primary,
        letterSpacing: '0.02em',
      }}
    >
      {children}
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
    <div
      style={{
        background: tokens.glass.bg.light,
        borderRadius: tokens.radius.md,
        overflow: 'hidden',
        fontSize: compact ? 11 : 12,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
          background: tokens.glass.bg.medium,
          padding: compact ? '6px 10px' : '8px 12px',
          fontWeight: 600,
          color: tokens.colors.text.tertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontSize: 12,
        }}
      >
        {headers.map((h, i) => (
          <div key={i}>{h}</div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
            padding: compact ? '6px 10px' : '8px 12px',
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.secondary,
          }}
        >
          {row.map((cell, j) => (
            <div key={j} style={{ fontFamily: j > 0 ? 'monospace' : 'inherit' }}>
              {cell}
            </div>
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
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <span
        style={{
          fontWeight: 600,
          color,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        {range}
      </span>
      <span style={{ color: tokens.colors.text.tertiary, fontSize: 12 }}>{description}</span>
    </div>
  )
}

export default ScoreRulesModal
