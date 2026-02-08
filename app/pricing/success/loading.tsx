import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'

/**
 * 支付成功页加载骨架屏
 */
export default function PricingSuccessLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      animation: 'pulse 1.5s ease-in-out infinite',
    }}>
      <Box style={{
        width: '100%',
        maxWidth: 480,
        padding: tokens.spacing[6],
        textAlign: 'center',
      }}>
        <Box style={{ width: 64, height: 64, borderRadius: '50%', background: tokens.colors.bg.tertiary, margin: '0 auto', marginBottom: tokens.spacing[4] }} />
        <Box style={{ width: 200, height: 24, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, margin: '0 auto', marginBottom: tokens.spacing[3] }} />
        <Box style={{ width: 280, height: 16, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, margin: '0 auto' }} />
      </Box>
    </Box>
  )
}
