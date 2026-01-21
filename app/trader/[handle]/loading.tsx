import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Trader 页面加载状态
 * 使用 Next.js 流式渲染，在数据加载时显示骨架屏
 */
export default function TraderLoading() {
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
          marginBottom: tokens.spacing[6]
        }}>
          {/* Avatar */}
          <Box style={{
            width: 80,
            height: 80,
            borderRadius: '50%',
            background: tokens.colors.bg.tertiary,
            opacity: 0.6,
          }} />
          
          {/* Name and stats */}
          <Box style={{ flex: 1 }}>
            <Box style={{
              width: 200,
              height: 24,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              marginBottom: tokens.spacing[2],
              opacity: 0.7,
            }} />
            <Box style={{
              width: 120,
              height: 16,
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
              opacity: 0.5,
            }} />
          </Box>
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
        
        {/* Content Skeleton */}
        <RankingSkeleton />
      </Box>
    </Box>
  )
}
