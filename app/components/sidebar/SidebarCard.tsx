'use client'

interface SidebarCardProps {
  title: string
  children: React.ReactNode
}

export default function SidebarCard({ title, children }: SidebarCardProps) {
  return (
    <div className="sidebar-card">
      <h3 style={{
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--color-text-secondary)',
        marginBottom: 12,
        paddingBottom: 8,
        borderBottom: '1px solid var(--color-border-primary)',
        letterSpacing: '0.02em',
        textTransform: 'uppercase' as const,
      }}>
        {title}
      </h3>
      {children}
    </div>
  )
}
