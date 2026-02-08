import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'

/**
 * 重置密码页加载骨架屏
 */
export default function ResetPasswordLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Box style={{
        width: '100%',
        maxWidth: 400,
        padding: tokens.spacing[6],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        animation: 'pulse 1.5s ease-in-out infinite',
      }}>
        <Box style={{ width: 180, height: 24, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, margin: '0 auto', marginBottom: tokens.spacing[6] }} />
        <Box style={{ width: '100%', height: 44, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[3] }} />
        <Box style={{ width: '100%', height: 44, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary, marginTop: tokens.spacing[4] }} />
      </Box>
    </Box>
  )
}
