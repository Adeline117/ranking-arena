import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Inbox page loading state
 * Displays a skeleton UI while the inbox data is loading
 */
export default function InboxLoading() {
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
          width: 120,
          height: 32,
          borderRadius: tokens.radius.sm,
          background: tokens.colors.bg.tertiary,
          marginBottom: tokens.spacing[6],
          opacity: 0.7,
        }} />

        {/* Conversation List Skeleton */}
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Box key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.secondary,
              opacity: 0.6,
            }}>
              {/* Avatar */}
              <Box style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: tokens.colors.bg.tertiary,
                flexShrink: 0,
              }} />

              {/* Content */}
              <Box style={{ flex: 1 }}>
                <Box style={{
                  width: 150,
                  height: 18,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  marginBottom: tokens.spacing[2],
                }} />
                <Box style={{
                  width: 250,
                  height: 16,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  opacity: 0.7,
                }} />
              </Box>

              {/* Time */}
              <Box style={{
                width: 60,
                height: 14,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                opacity: 0.5,
              }} />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
