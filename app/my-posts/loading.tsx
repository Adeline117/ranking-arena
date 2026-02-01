import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * My Posts page loading state
 * Displays a skeleton UI while the posts data is loading
 */
export default function MyPostsLoading() {
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
          width: 150,
          height: 32,
          borderRadius: tokens.radius.sm,
          background: tokens.colors.bg.tertiary,
          marginBottom: tokens.spacing[6],
          opacity: 0.7,
        }} />

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

        {/* Posts List Skeleton */}
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {[1, 2, 3, 4, 5].map(i => (
            <Box key={i} style={{
              padding: tokens.spacing[5],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary,
              opacity: 0.6,
            }}>
              {/* Post header */}
              <Box style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
              }}>
                <Box style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: tokens.colors.bg.tertiary,
                }} />
                <Box>
                  <Box style={{
                    width: 120,
                    height: 16,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    marginBottom: tokens.spacing[1],
                  }} />
                  <Box style={{
                    width: 80,
                    height: 14,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    opacity: 0.7,
                  }} />
                </Box>
              </Box>

              {/* Post content */}
              <Box style={{
                width: '100%',
                height: 20,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                marginBottom: tokens.spacing[2],
              }} />
              <Box style={{
                width: '80%',
                height: 20,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                opacity: 0.7,
              }} />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
