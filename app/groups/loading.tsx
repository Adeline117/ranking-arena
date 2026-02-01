import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Groups page loading state
 * Displays a skeleton UI while the groups data is loading
 */
export default function GroupsLoading() {
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
            width: 120,
            height: 32,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.7,
          }} />
          <Box style={{
            width: 120,
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
          {[1, 2, 3].map(i => (
            <Box key={i} style={{
              width: 80,
              height: 20,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              opacity: 0.5 + i * 0.1,
            }} />
          ))}
        </Box>

        {/* Groups Grid Skeleton */}
        <Box style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: tokens.spacing[4],
        }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Box key={i} style={{
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary,
              overflow: 'hidden',
              opacity: 0.6,
            }}>
              {/* Cover image */}
              <Box style={{
                width: '100%',
                height: 120,
                background: tokens.colors.bg.tertiary,
              }} />

              {/* Group info */}
              <Box style={{ padding: tokens.spacing[4] }}>
                <Box style={{
                  width: '70%',
                  height: 20,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  marginBottom: tokens.spacing[2],
                }} />
                <Box style={{
                  width: '100%',
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  marginBottom: tokens.spacing[1],
                  opacity: 0.7,
                }} />
                <Box style={{
                  width: '80%',
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  opacity: 0.7,
                }} />

                {/* Stats */}
                <Box style={{
                  display: 'flex',
                  gap: tokens.spacing[3],
                  marginTop: tokens.spacing[3],
                }}>
                  <Box style={{
                    width: 60,
                    height: 14,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    opacity: 0.5,
                  }} />
                  <Box style={{
                    width: 60,
                    height: 14,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    opacity: 0.5,
                  }} />
                </Box>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
