import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

export default function Loading() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 680, margin: '0 auto', padding: `${tokens.spacing[5]} ${tokens.spacing[4]}` }}>
        {/* Tab bar skeleton */}
        <Box style={{
          display: 'flex',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} 0`,
          marginBottom: tokens.spacing[3],
        }}>
          {[64, 48, 56, 48, 48].map((w, i) => (
            <Box key={i} style={{
              width: w,
              height: 36,
              borderRadius: tokens.radius.full,
              background: tokens.colors.bg.tertiary,
              animation: 'skeletonPulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </Box>

        {/* Result cards skeleton */}
        <Box style={{
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflow: 'hidden',
        }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Box key={i} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: tokens.spacing[3],
              padding: tokens.spacing[4],
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}>
              <Box style={{
                width: 44,
                height: 44,
                borderRadius: tokens.radius.full,
                background: tokens.colors.bg.tertiary,
                animation: 'skeletonPulse 1.5s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <Box style={{ flex: 1 }}>
                <Box style={{
                  width: `${40 + i * 8}%`,
                  height: 14,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  marginBottom: 8,
                  animation: 'skeletonPulse 1.5s ease-in-out infinite',
                }} />
                <Box style={{
                  width: `${25 + i * 5}%`,
                  height: 11,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  animation: 'skeletonPulse 1.5s ease-in-out infinite',
                }} />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
