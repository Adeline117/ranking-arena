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
              aria-expanded={widgetsExpanded}
              aria-label={widgetsExpanded ? t('collapseWidgets') : t('expandWidgets')}
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background: widgetsExpanded ? 'var(--color-bg-tertiary)' : 'var(--color-bg-secondary)',
                border: `1px solid ${widgetsExpanded ? 'var(--color-accent-primary-30)' : 'var(--color-border-primary)'}`,
                borderRadius: tokens.radius.lg,
                color: widgetsExpanded ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[2],
                minHeight: 44,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                if (!widgetsExpanded) {
                  e.currentTarget.style.background = 'var(--color-bg-tertiary)'
                  e.currentTarget.style.color = 'var(--color-text-primary)'
                  e.currentTarget.style.borderColor = 'var(--color-border-secondary)'
                }
              }}
              onMouseLeave={(e) => {
                if (!widgetsExpanded) {
                  e.currentTarget.style.background = 'var(--color-bg-secondary)'
                  e.currentTarget.style.color = 'var(--color-text-secondary)'
                  e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                }
              }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span>{widgetsExpanded ? t('collapseWidgets') : t('expandWidgets')}</span>
              <svg
                width={16} height={16} viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2"
                style={{
                  transform: widgetsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div 
              style={{
                overflow: 'hidden',
                transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
                maxHeight: widgetsExpanded ? '2000px' : '0px',
                opacity: widgetsExpanded ? 1 : 0,
              }}
            >
              {widgetsExpanded && (
                <div style={{ 
                  marginTop: tokens.spacing[3], 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: tokens.spacing[4],
                  paddingBottom: tokens.spacing[2],
                }}>
                  {leftSidebar}
                  {rightSidebar}
                </div>
              )}
            </div>
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
