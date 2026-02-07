'use client'
import { tokens } from '@/lib/design-tokens'

interface SidebarCardProps {
  title: string
  children: React.ReactNode
}

export default function SidebarCard({ title, children }: SidebarCardProps) {
  return (
    <div style={{
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
      borderRadius: tokens.radius.lg,
      padding: tokens.spacing[4],
    }}>
      <h3 style={{
        fontSize: 14,
        fontWeight: 700,
        color: tokens.colors.text.primary,
        marginBottom: tokens.spacing[3],
        paddingBottom: tokens.spacing[2],
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        letterSpacing: '-0.01em',
      }}>
        {title}
      </h3>
      {children}
    </div>
  )
}
