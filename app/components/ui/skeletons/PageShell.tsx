import React from 'react'
import { tokens } from '@/lib/design-tokens'

/**
 * Shared wrapper for full-page skeleton layouts.
 * The parent (app) layout already owns the persistent TopNav. Keeping another
 * 56px placeholder here made every route skeleton start one nav-height below
 * its final page, then jump upward when the route resolved.
 */
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading page content"
      style={{
        minHeight: 'calc(100vh - 56px)',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
