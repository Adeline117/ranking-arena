'use client'

import { type ReactNode, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

interface ThreeColumnLayoutProps {
  leftSidebar?: ReactNode
  rightSidebar?: ReactNode
  children: ReactNode
}

/**
 * Three-column layout:
 * - Desktop (≥1024px): Left sticky | Center scrollable | Right sticky
 * - Mobile (<1024px): Center content only + collapsible sidebar widgets at bottom
 * 
 * Width ratio: ~1:2:1
 * Left/right are sticky with their own scroll
 */
export default function ThreeColumnLayout({
  leftSidebar,
  rightSidebar,
  children,
}: ThreeColumnLayoutProps) {
  const { t } = useLanguage()
  const [widgetsExpanded, setWidgetsExpanded] = useState(false)
  const hasSidebarContent = !!(leftSidebar || rightSidebar)

  return (
    <div className="three-col-layout">
      {/* Left sidebar — hidden on mobile */}
      {leftSidebar && (
        <aside className="three-col-left hide-tablet">
          {leftSidebar}
        </aside>
      )}

      {/* Center content — always visible, scrollable */}
      <main className="three-col-center" style={{ minWidth: 0 }}>
        {children}

        {/* Mobile: collapsible sidebar widgets */}
        {hasSidebarContent && (
          <div className="mobile-sidebar-widgets">
            <button
              onClick={() => setWidgetsExpanded(!widgetsExpanded)}
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-primary)',
                borderRadius: tokens.radius.lg,
                color: 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[2],
                minHeight: 44,
              }}
            >
              <span>{widgetsExpanded ? t('collapseWidgets') : t('expandWidgets')}</span>
              <svg
                width={16} height={16} viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2"
                style={{
                  transform: widgetsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s ease',
                }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {widgetsExpanded && (
              <div style={{ marginTop: tokens.spacing[3], display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {leftSidebar}
                {rightSidebar}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Right sidebar — hidden on mobile */}
      {rightSidebar && (
        <aside className="three-col-right hide-mobile">
          {rightSidebar}
        </aside>
      )}
    </div>
  )
}
