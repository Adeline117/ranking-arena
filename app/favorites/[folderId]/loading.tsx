import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Folder detail page loading state
 * Displays a skeleton UI while the folder content is loading
 */
export default function FolderLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary
    }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Back button and header */}
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[6],
        }}>
          <Box style={{
            width: 32,
            height: 32,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.6,
          }} />
          <Box style={{
            width: 200,
            height: 28,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.7,
          }} />
        </Box>

        {/* Folder info */}
        <Box style={{
          padding: tokens.spacing[5],
          borderRadius: tokens.radius.lg,
          background: tokens.colors.bg.secondary,
          marginBottom: tokens.spacing[6],
          opacity: 0.6,
        }}>
          <Box style={{
            width: 150,
            height: 20,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            marginBottom: tokens.spacing[2],
          }} />
          <Box style={{
            width: 80,
            height: 16,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
            opacity: 0.7,
          }} />
        </Box>

        {/* Content Skeleton */}
        <RankingSkeleton />
      </Box>
    </Box>
  )
}
