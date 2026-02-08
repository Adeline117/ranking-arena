/**
 * HomePageShell - Server Component
 * Renders the static layout shell immediately without waiting for client hydration.
 * This improves LCP by showing the page structure before JavaScript loads.
 */

import { ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'

interface HomePageShellProps {
  children: ReactNode
  topNav: ReactNode
  bottomNav: ReactNode
}

export default function HomePageShell({ children, topNav, bottomNav }: HomePageShellProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        position: 'relative',
      }}
    >
      {/* Background mesh gradient - static, rendered on server */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          contain: 'strict',
        }}
      />

      {/* JSON-LD 结构化数据 - static */}
      <JsonLd data={combineSchemas(generateWebSiteSchema(), generateOrganizationSchema())} />

      {/* 顶部导航 */}
      {topNav}

      {/* 主体内容 */}
      <main
        className="container-padding page-enter has-mobile-nav"
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          position: 'relative',
          zIndex: 1,
          padding: '16px 16px',
        }}
      >
        {children}
      </main>

      {/* 移动端底部导航 */}
      {bottomNav}
    </div>
  )
}
