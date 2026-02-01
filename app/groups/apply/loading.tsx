import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Group application page loading state
 * Displays a skeleton UI while the application form is loading
 */
export default function GroupApplyLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary
    }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <Box style={{
          width: 200,
          height: 32,
          borderRadius: tokens.radius.sm,
          background: tokens.colors.bg.tertiary,
          marginBottom: tokens.spacing[6],
          opacity: 0.7,
        }} />

        {/* Form Skeleton */}
        <Box style={{
          padding: tokens.spacing[6],
          borderRadius: tokens.radius.lg,
          background: tokens.colors.bg.secondary,
          opacity: 0.6,
        }}>
          {/* Form fields */}
          {[1, 2, 3, 4].map(i => (
            <Box key={i} style={{ marginBottom: tokens.spacing[5] }}>
              <Box style={{
                width: 120,
                height: 16,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                marginBottom: tokens.spacing[2],
              }} />
              <Box style={{
                width: '100%',
                height: i === 3 ? 120 : 40,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.tertiary,
                opacity: 0.7,
              }} />
            </Box>
          ))}

          {/* Submit button */}
          <Box style={{
            width: 120,
            height: 40,
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.tertiary,
            marginTop: tokens.spacing[6],
          }} />
        </Box>
      </Box>
    </Box>
  )
}
