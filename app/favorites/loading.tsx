import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Favorites page loading state
 * Displays a skeleton UI while the favorites data is loading
 */
export default function FavoritesLoading() {
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
            width: 150,
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

        {/* Folders Grid Skeleton */}
        <Box style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
          gap: tokens.spacing[4],
          marginBottom: tokens.spacing[6],
        }}>
          {[1, 2, 3, 4].map(i => (
            <Box key={i} style={{
              padding: tokens.spacing[5],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary,
              opacity: 0.6,
            }}>
              <Box style={{
                width: 48,
                height: 48,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.tertiary,
                marginBottom: tokens.spacing[3],
              }} />
              <Box style={{
                width: '80%',
                height: 20,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                marginBottom: tokens.spacing[2],
              }} />
              <Box style={{
                width: '40%',
                height: 16,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                opacity: 0.7,
              }} />
            </Box>
          ))}
        </Box>

        {/* Content Skeleton */}
        <RankingSkeleton />
      </Box>
    </Box>
  )
}
