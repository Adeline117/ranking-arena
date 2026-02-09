import { tokens } from '@/lib/design-tokens'

export default function Loading() {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      {/* TopNav placeholder */}
      <div style={{ height: 56, background: 'rgba(11,10,16,0.85)', borderBottom: '1px solid rgba(255,255,255,0.08)' }} />
      
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '80px 16px 100px' }}>
        {/* Hero skeleton */}
        <div style={{
          marginBottom: 32, padding: '32px 28px', borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <div className="skeleton" style={{ height: 32, width: 200, marginBottom: 8, borderRadius: tokens.radius.md }} />
          <div className="skeleton" style={{ height: 20, width: 350, marginBottom: 24, borderRadius: 6 }} />
          <div className="skeleton" style={{ height: 44, maxWidth: 560, borderRadius: tokens.radius.lg }} />
        </div>

        {/* Grid skeleton */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 20,
        }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="skeleton" style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg }} />
              <div className="skeleton" style={{ height: 14, width: '80%', borderRadius: 4 }} />
              <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 4 }} />
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
