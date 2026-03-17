import { PageShell } from '@/app/components/ui/PageSkeleton'

export default function Loading() {
  return (
    <PageShell>
      {/* Hero section skeleton */}
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <div className="skeleton" style={{ height: 40, width: 300, margin: '0 auto 16px', borderRadius: 8 }} />
        <div className="skeleton" style={{ height: 20, width: 500, maxWidth: '80%', margin: '0 auto 32px', borderRadius: 6 }} />
        <div className="skeleton" style={{ height: 48, width: 400, maxWidth: '70%', margin: '0 auto', borderRadius: 12 }} />
      </div>
      {/* Content skeleton */}
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 120, borderRadius: 12 }} />
        ))}
      </div>
    </PageShell>
  )
}
