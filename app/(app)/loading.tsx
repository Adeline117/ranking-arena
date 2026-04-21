/**
 * Route-group loading skeleton for (app) pages.
 * Shown during client-side navigation while the new page loads.
 * Lightweight: zero heavy imports, inline styles only.
 */
export default function AppLoading() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #0B0A10)' }}>
      {/* Nav-height spacer */}
      <div
        style={{
          height: 56,
          background: 'var(--glass-bg, rgba(20,18,28,0.85))',
          borderBottom: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
        }}
      />
      {/* Centered skeleton bars */}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>
        {/* Title skeleton */}
        <div
          className="skeleton"
          style={{ height: 24, width: '40%', borderRadius: 6, marginBottom: 16 }}
        />
        {/* Content skeleton bars */}
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="skeleton"
            style={{
              height: 52,
              width: '100%',
              borderRadius: 8,
              marginBottom: 8,
            }}
          />
        ))}
      </div>
    </div>
  )
}
