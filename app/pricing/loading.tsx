import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * 定价页加载骨架屏
 */
export default function PricingLoading() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* 标题骨架 */}
        <Box style={{
          width: 200,
          height: 32,
          borderRadius: tokens.radius.md,
          background: tokens.colors.bg.tertiary,
          margin: '0 auto',
          marginBottom: tokens.spacing[6],
        }} />
        {/* 定价卡片骨架 */}
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[4] }}>
          {[1, 2, 3].map(i => (
            <Box key={i} style={{
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              padding: tokens.spacing[6],
              height: 360,
              opacity: 0.7,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              <Box style={{ width: 100, height: 20, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, marginBottom: tokens.spacing[4] }} />
              <Box style={{ width: 140, height: 36, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, marginBottom: tokens.spacing[6] }} />
              {[1, 2, 3, 4].map(j => (
                <Box key={j} style={{ width: '80%', height: 14, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, marginBottom: tokens.spacing[3] }} />
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
