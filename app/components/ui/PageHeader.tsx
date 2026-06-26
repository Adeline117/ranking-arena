import React from 'react'
import { tokens } from '@/lib/design-tokens'

export interface PageHeaderProps {
  /** Page title — rendered as the confident <h1>. */
  title: React.ReactNode
  /** Optional supporting line under the title. */
  subtitle?: React.ReactNode
  /** Optional right-aligned slot (filters, buttons). */
  actions?: React.ReactNode
  /** Tighter bottom margin when content packs right under the header. */
  compact?: boolean
  style?: React.CSSProperties
}

/**
 * PageHeader — the single confident page header.
 *
 * Encodes the "sharp typography hierarchy + generous whitespace" principles
 * (Refactoring UI / Stripe-Linear-Vercel): one large, heavy title (clamp 28→40px,
 * weight 900) + a readable subtitle, with real breathing room below. Replaces the
 * timid, inconsistent hand-rolled 20–28px titles across pages.
 */
export default function PageHeader({ title, subtitle, actions, compact, style }: PageHeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: tokens.spacing[4],
        flexWrap: 'wrap',
        marginBottom: compact ? tokens.spacing[6] : tokens.spacing[8],
        ...style,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            fontSize: 'clamp(28px, 3.5vw, 40px)',
            fontWeight: tokens.typography.fontWeight.black,
            color: 'var(--color-text-primary)',
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            margin: 0,
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              fontSize: tokens.typography.fontSize.md,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.55,
              margin: 0,
              marginTop: tokens.spacing[2],
              maxWidth: 620,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
    </header>
  )
}
