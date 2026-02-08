import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * 系统状态页加载骨架屏
 */
export default function StatusLoading() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], animation: 'pulse 1.5s ease-in-out infinite' }}>
        <Box style={{ width: 160, height: 28, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[6] }} />
        {[1, 2, 3, 4].map(i => (
          <Box key={i} style={{
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            padding: tokens.spacing[4],
            marginBottom: tokens.spacing[3],
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <Box style={{ width: 140, height: 16, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm }} />
            <Box style={{ width: 60, height: 24, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.full }} />
          </Box>
        ))}
      </Box>
    </Box>
  )
}
