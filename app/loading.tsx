import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton, SkeletonCard } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

/**
 * 首页加载状态
 * 使用 Next.js 流式渲染，在数据加载时显示骨架屏
 */
export default function HomeLoading() {
  // 骨架屏动画样式
  const _pulseStyle = {
    animation: 'pulse 1.5s ease-in-out infinite',
  }

  return (
    <Box style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary 
    }}>
      <TopNav email={null} />
      
      <Box
        as="main"
        className="container-padding"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: tokens.spacing[6],
        }}
      >
        <Box
          className="main-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '260px minmax(0, 1fr) 280px',
            gap: tokens.spacing[4],
            alignItems: 'start',
          }}
        >
          {/* Left Column - Posts Skeleton */}
          <Box className="home-left-section">
            <Box style={{
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              padding: tokens.spacing[4],
            }}>
              <Box style={{
                width: 120,
                height: 20,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
                marginBottom: tokens.spacing[4],
                opacity: 0.7,
              }} />
              {[1, 2, 3].map(i => (
                <Box key={i} style={{
                  padding: tokens.spacing[3],
                  marginBottom: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.tertiary,
                  opacity: 0.5 + i * 0.1,
                }}>
                  <Box style={{ width: '100%', height: 16, marginBottom: tokens.spacing[2] }} />
                  <Box style={{ width: '60%', height: 12 }} />
                </Box>
              ))}
            </Box>
          </Box>

          {/* Center Column - Ranking Skeleton */}
          <Box className="home-ranking-section">
            {/* Time Range Tabs */}
            <Box style={{
              display: 'flex',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}>
              {[1, 2, 3].map(i => (
                <Box key={i} style={{
                  flex: 1,
                  height: 36,
                  borderRadius: tokens.radius.md,
                  background: i === 1 ? tokens.colors.bg.tertiary : 'transparent',
                  opacity: 0.6,
                }} />
              ))}
            </Box>
            
            <RankingSkeleton />
          </Box>

          {/* Right Column - Market Skeleton */}
          <Box className="home-right-section">
            <SkeletonCard />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
