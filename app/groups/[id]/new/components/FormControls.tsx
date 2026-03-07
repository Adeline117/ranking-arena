'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'

// ─── Shared input style ──────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: tokens.radius.md,
  border: ('1px solid ' + tokens.colors.border.primary),
  background: tokens.colors.bg.secondary,
  color: tokens.colors.text.primary,
  fontSize: tokens.typography.fontSize.base,
  outline: 'none',
  fontFamily: tokens.typography.fontFamily.sans.join(', '),
}

// ─── CharCount ───────────────────────────────────────────────────────

interface CharCountProps {
  current: number
  max: number
}

export function CharCount({ current, max }: CharCountProps): React.ReactElement {
  const isOver = current > max
  return (
    <Text size="xs" style={{ color: isOver ? tokens.colors.accent.error : tokens.colors.text.tertiary }}>
      {current}/{max}
    </Text>
  )
}

// ─── ToggleSwitch ────────────────────────────────────────────────────

interface ToggleSwitchProps {
  enabled: boolean
  onToggle: () => void
  label: string
  description?: string
}

export function ToggleSwitch({ enabled, onToggle, label, description }: ToggleSwitchProps): React.ReactElement {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.md,
        border: `1px solid ${enabled ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
        background: enabled ? 'var(--color-accent-primary-10)' : tokens.colors.bg.secondary,
        cursor: 'pointer',
        transition: `all ${tokens.transition.base}`,
      }}
      onClick={onToggle}
    >
      <Box
        style={{
          width: 44,
          height: 24,
          borderRadius: tokens.radius.lg,
          background: enabled ? tokens.colors.accent.brand : tokens.colors.border.primary,
          position: 'relative',
          transition: 'background 0.2s ease',
        }}
      >
        <Box
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: tokens.colors.white,
            position: 'absolute',
            top: 2,
            left: enabled ? 22 : 2,
            transition: 'left 0.2s ease',
            boxShadow: '0 1px 3px var(--color-overlay-medium)',
          }}
        />
      </Box>
      <Box>
        <Text size="sm" weight="bold" style={{ color: enabled ? tokens.colors.accent.brand : tokens.colors.text.primary }}>
          {label}
        </Text>
        {description && <Text size="xs" color="tertiary">{description}</Text>}
      </Box>
    </Box>
  )
}
