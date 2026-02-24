
interface SidebarCardProps {
  title: string
  children: React.ReactNode
}

export default function SidebarCard({ title, children }: SidebarCardProps) {
  return (
    <div className="sidebar-card card-hover">
      <h3 style={{
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--color-text-primary)',
        marginBottom: 14,
        paddingBottom: 10,
        borderBottom: '1px solid var(--color-border-primary)',
        letterSpacing: '0.01em',
      }}>
        {title}
      </h3>
      {children}
    </div>
  )
}
