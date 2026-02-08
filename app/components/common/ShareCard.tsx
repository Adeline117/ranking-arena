'use client'

import { tokens } from '@/lib/design-tokens'

interface ShareCardProps {
  title: string
  subtitle?: string
  description?: string
  imageUrl?: string
  stats?: Array<{ label: string; value: string }>
}

/**
 * OG image preview card component — renders a styled card
 * that mirrors the OG image layout for visual consistency.
 */
export default function ShareCard({ title, subtitle, description, imageUrl, stats }: ShareCardProps) {
  return (
    <div style={{
      width: '100%', maxWidth: 600,
      borderRadius: tokens.radius.xl,
      overflow: 'hidden',
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
      boxShadow: tokens.shadow.lg,
    }}>
      {/* Top gradient bar */}
      <div style={{
        height: 4,
        background: tokens.gradient.primary,
      }} />

      <div style={{ padding: '20px 24px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {imageUrl && (
          <img
            src={imageUrl}
            alt=""
            style={{
              width: 64, height: 64, borderRadius: tokens.radius.lg,
              objectFit: 'cover', flexShrink: 0,
            }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{
            margin: 0, fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.bold,
            color: tokens.colors.text.primary,
            lineHeight: tokens.typography.lineHeight.tight,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title}
          </h3>
          {subtitle && (
            <p style={{
              margin: '4px 0 0', fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}>
              {subtitle}
            </p>
          )}
          {description && (
            <p style={{
              margin: '8px 0 0', fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.tertiary,
              lineHeight: tokens.typography.lineHeight.normal,
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
            }}>
              {description}
            </p>
          )}
        </div>
      </div>

      {stats && stats.length > 0 && (
        <div style={{
          display: 'flex', borderTop: `1px solid ${tokens.colors.border.primary}`,
          padding: '12px 24px', gap: 24,
        }}>
          {stats.map((s, i) => (
            <div key={i}>
              <div style={{
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.bold,
                color: tokens.colors.text.primary,
              }}>
                {s.value}
              </div>
              <div style={{
                fontSize: 11, color: tokens.colors.text.tertiary,
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer branding */}
      <div style={{
        padding: '8px 24px',
        borderTop: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 11, color: tokens.colors.text.tertiary,
      }}>
        ArenaFi
      </div>
    </div>
  )
}
