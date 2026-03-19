'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'

interface ContentWarningToggleProps {
  isSensitive: boolean
  onToggle: (value: boolean) => void
  contentWarning: string
  onContentWarningChange: (value: string) => void
}

export function ContentWarningToggle({
  isSensitive,
  onToggle,
  contentWarning,
  onContentWarningChange,
}: ContentWarningToggleProps) {
  const { t } = useLanguage()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        cursor: 'pointer',
        userSelect: 'none',
      }}>
        <div
          onClick={() => onToggle(!isSensitive)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: isSensitive ? tokens.colors.accent.warning : tokens.colors.bg.tertiary,
            border: `1px solid ${isSensitive ? tokens.colors.accent.warning : tokens.colors.border.primary}`,
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 0.2s, border-color 0.2s',
          }}
        >
          <div style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'white',
            position: 'absolute',
            top: 1,
            left: isSensitive ? 17 : 1,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }} />
        </div>
        <div>
          <div style={{
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 600,
            color: tokens.colors.text.primary,
          }}>
            {t('markSensitive')}
          </div>
          <div style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
          }}>
            {t('contentWarning')}
          </div>
        </div>
      </label>

      {isSensitive && (
        <input
          type="text"
          value={contentWarning}
          onChange={(e) => onContentWarningChange(e.target.value.slice(0, 200))}
          placeholder={t('contentWarningPlaceholder')}
          maxLength={200}
          style={{
            width: '100%',
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.accent.warning}40`,
            background: `${tokens.colors.accent.warning}10`,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            outline: 'none',
          }}
        />
      )}
    </div>
  )
}

export default ContentWarningToggle
