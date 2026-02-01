import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Group management page loading state
 * Displays a skeleton UI while the management interface is loading
 */
export default function GroupManageLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary
    }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <Box style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[6],
        }}>
          <Box style={{
            width: 180,
            height: 32,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.7,
          }} />
          <Box style={{
            width: 100,
            height: 36,
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.tertiary,
            opacity: 0.6,
          }} />
        </Box>

        {/* Tabs Skeleton */}
        <Box style={{
          display: 'flex',
          gap: tokens.spacing[4],
          marginBottom: tokens.spacing[6],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          paddingBottom: tokens.spacing[3],
        }}>
          {[1, 2, 3, 4].map(i => (
            <Box key={i} style={{
              width: 100,
              height: 20,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              opacity: 0.5 + i * 0.1,
            }} />
          ))}
        </Box>

        {/* Content Skeleton */}
        <Box style={{
          padding: tokens.spacing[6],
          borderRadius: tokens.radius.lg,
          background: tokens.colors.bg.secondary,
          opacity: 0.6,
        }}>
          {/* Section 1 */}
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <Box style={{
              width: 150,
              height: 24,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              marginBottom: tokens.spacing[4],
            }} />
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {[1, 2, 3].map(i => (
                <Box key={i} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.tertiary,
                  opacity: 0.5,
                }}>
                  <Box style={{
                    width: 200,
                    height: 16,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.primary,
                  }} />
                  <Box style={{
                    width: 80,
                    height: 32,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.primary,
                  }} />
                </Box>
              ))}
            </Box>
          </Box>

          {/* Section 2 */}
          <Box>
            <Box style={{
              width: 150,
              height: 24,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              marginBottom: tokens.spacing[4],
            }} />
            <Box style={{
              width: '100%',
              height: 200,
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.tertiary,
              opacity: 0.5,
            }} />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
