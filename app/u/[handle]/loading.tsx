import { tokens } from '@/lib/design-tokens'

export default function UserProfileLoading() {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Profile header skeleton */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            minHeight: 200,
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[6],
            background: `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}50`,
            gap: tokens.spacing[5],
          }}
        >
          {/* Avatar skeleton */}
          <div className="skeleton" style={{ width: 72, height: 72, borderRadius: '50%', flexShrink: 0 }} />
          {/* Info skeleton */}
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ width: 160, height: 28, borderRadius: tokens.radius.md, marginBottom: 12 }} />
            <div className="skeleton" style={{ width: 240, height: 16, borderRadius: tokens.radius.sm, marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: tokens.spacing[4] }}>
              <div className="skeleton" style={{ width: 80, height: 20, borderRadius: tokens.radius.sm }} />
              <div className="skeleton" style={{ width: 80, height: 20, borderRadius: tokens.radius.sm }} />
            </div>
          </div>
        </div>

        {/* Content skeleton */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: tokens.spacing[6] }}>
          <div>
            <div className="skeleton" style={{ height: 400, borderRadius: tokens.radius.lg }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            <div className="skeleton" style={{ height: 150, borderRadius: tokens.radius.lg }} />
            <div className="skeleton" style={{ height: 150, borderRadius: tokens.radius.lg }} />
          </div>
        </div>
      </div>
    </div>
  )
}
