'use client'

import { type ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

interface ThreeColumnLayoutProps {
  leftSidebar?: ReactNode
  rightSidebar?: ReactNode
  children: ReactNode
}

/**
 * Three-column layout:
 * - Desktop (≥1024px): Left sticky | Center scrollable | Right sticky
 * - Mobile (<1024px): Center content only
 * 
 * Width ratio: ~1:2:1
 * Left/right are sticky with their own scroll
 */
export default function ThreeColumnLayout({
  leftSidebar,
  rightSidebar,
  children,
}: ThreeColumnLayoutProps) {
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
