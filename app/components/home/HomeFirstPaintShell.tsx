import type { ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

function SkeletonLines({ count, height }: { count: number; height: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton" style={{ height, borderRadius: tokens.radius.md }} />
      ))}
    </div>
  )
}

function SidebarSkeleton({ rows, rowHeight }: { rows: number; rowHeight: number }) {
  return (
    <div
      className="sidebar-card"
      style={{
        minHeight: rowHeight * rows + tokens.spacing[8],
        borderRadius: tokens.radius.lg,
      }}
    >
      <div
        className="skeleton"
        style={{
          width: '58%',
          height: 13,
          marginBottom: tokens.spacing[4],
          borderRadius: tokens.radius.sm,
        }}
      />
      <SkeletonLines count={rows} height={rowHeight} />
    </div>
  )
}

/**
 * First-paint homepage shell.
 *
 * The interactive homepage is intentionally downloaded after the server HTML,
 * but its desktop information architecture must not appear late. This shell
 * reserves the exact source-strip + left/center/right grid from the first paint
 * while keeping the real server-rendered rankings usable.
 */
export default function HomeFirstPaintShell({ children }: { children: ReactNode }) {
  return (
    <div id="ssr-home-content-shell" className="home-page-container">
      <div
        data-testid="first-paint-source-strip"
        aria-hidden="true"
        style={{
          height: 47,
          padding: '10px 0',
          overflow: 'hidden',
          borderBottom: '1px solid var(--color-border-primary)',
          contain: 'layout style paint',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[5] }}>
          {Array.from({ length: 8 }, (_, index) => (
            <span
              key={index}
              className="skeleton"
              style={{
                display: 'block',
                width: 96,
                minWidth: 96,
                height: 26,
                borderRadius: tokens.radius.md,
              }}
            />
          ))}
        </div>
      </div>

      <div id="ssr-ranking-table" className="three-col-layout">
        <aside
          data-testid="first-paint-left"
          className="three-col-left hide-tablet"
          aria-hidden="true"
          style={{ contain: 'layout style' }}
        >
          <SidebarSkeleton rows={5} rowHeight={46} />
        </aside>

        <div data-testid="first-paint-center" className="three-col-center">
          {children}
        </div>

        <aside
          data-testid="first-paint-right"
          className="three-col-right hide-mobile"
          aria-hidden="true"
          style={{
            contain: 'layout style',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[4],
          }}
        >
          <SidebarSkeleton rows={4} rowHeight={40} />
          <SidebarSkeleton rows={5} rowHeight={44} />
        </aside>
      </div>
    </div>
  )
}
