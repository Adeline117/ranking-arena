import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Conversation page loading state
 * Displays a skeleton UI while the conversation data is loading
 */
export default function ConversationLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary
    }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header Skeleton */}
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[4],
          marginBottom: tokens.spacing[6],
          paddingBottom: tokens.spacing[4],
          borderBottom: `1px solid ${tokens.colors.border.primary}`
        }}>
          {/* Avatar */}
          <Box style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: tokens.colors.bg.tertiary,
            opacity: 0.6,
          }} />

          {/* Name */}
          <Box style={{
            width: 150,
            height: 20,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.7,
          }} />
        </Box>

        {/* Messages Skeleton */}
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {[1, 2, 3, 4, 5].map(i => (
            <Box key={i} style={{
              display: 'flex',
              justifyContent: i % 2 === 0 ? 'flex-start' : 'flex-end',
            }}>
              <Box style={{
                maxWidth: '70%',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.tertiary,
                opacity: 0.6,
              }}>
                <Box style={{
                  width: Math.random() * 200 + 100,
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.primary,
                  marginBottom: tokens.spacing[2],
                  opacity: 0.4,
                }} />
                <Box style={{
                  width: Math.random() * 150 + 80,
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.primary,
                  opacity: 0.4,
                }} />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
