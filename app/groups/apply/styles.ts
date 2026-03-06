import { tokens } from '@/lib/design-tokens'

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
  borderRadius: tokens.radius.lg,
  border: ('1px solid ' + tokens.colors.border.primary),
  background: tokens.colors.bg.primary,
  color: tokens.colors.text.primary,
  fontSize: tokens.typography.fontSize.base,
  outline: 'none',
  transition: `border-color ${tokens.transition.base}`,
}

export const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: tokens.spacing[2],
  fontSize: tokens.typography.fontSize.sm,
  fontWeight: tokens.typography.fontWeight.semibold,
  color: tokens.colors.text.secondary,
}

export const tabStyle = (isActive: boolean): React.CSSProperties => ({
  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
  borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
  border: `1px solid ${isActive ? tokens.colors.border.primary : 'transparent'}`,
  borderBottom: isActive ? 'none' : `1px solid ${tokens.colors.border.primary}`,
  background: isActive ? tokens.colors.bg.secondary : 'transparent',
  color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
  cursor: 'pointer',
  fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
  transition: `all ${tokens.transition.base}`,
})
