import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { SkeletonCard } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

/**
 * 群组详情页加载状态
 */
export default function GroupLoading() {
  return (
    <Box style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary 
    }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Group Header Skeleton */}
        <Box style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: tokens.spacing[4],
          marginBottom: tokens.spacing[6],
          padding: tokens.spacing[4],
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          {/* Avatar */}
          <Box style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.tertiary,
            opacity: 0.6,
          }} />
          
          {/* Name and description */}
          <Box style={{ flex: 1 }}>
            <Box style={{
              width: 180,
              height: 24,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              marginBottom: tokens.spacing[2],
              opacity: 0.7,
            }} />
            <Box style={{
              width: '80%',
              height: 16,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              opacity: 0.5,
            }} />
          </Box>
          
          {/* Join Button */}
          <Box style={{
            width: 80,
            height: 36,
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.tertiary,
            opacity: 0.5,
          }} />
        </Box>
        
        {/* Posts Skeleton */}
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {[1, 2, 3].map(i => (
            <SkeletonCard key={i} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
