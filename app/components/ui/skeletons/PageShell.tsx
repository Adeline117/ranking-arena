import React from 'react'
import { tokens } from '@/lib/design-tokens'

/**
 * Shared wrapper for full-page skeleton layouts.
 * Renders a TopNav placeholder and centered content area.
 */
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* TopNav placeholder */}
      <div style={{ height: 56, background: 'var(--glass-bg-primary)', borderBottom: `1px solid ${tokens.colors.border.primary}` }} />
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {children}
      </div>
    </div>
  )
}
