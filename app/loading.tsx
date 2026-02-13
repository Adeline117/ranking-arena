import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { Skeleton, RankingSkeleton, SkeletonCard } from '@/app/components/ui/Skeleton'

/**
 * 首页加载状态
 * 使用 Next.js 流式渲染，在数据加载时显示骨架屏
 */
export default function HomeLoading() {
  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary,
    }}>
      {/* TopNav placeholder */}
      <div style={{ height: 56, background: 'var(--glass-bg-primary)', borderBottom: `1px solid ${tokens.colors.border.primary}` }} />

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
            gap: tokens.spacing[4],
            alignItems: 'start',
          }}
        >
          {/* Left Column - Posts Skeleton */}
          <Box className="home-left-section">
            <Box className="glass-card" style={{
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[4],
            }}>
              <Skeleton width="120px" height="20px" style={{ marginBottom: tokens.spacing[4] }} />
              {[1, 2, 3].map(i => (
                <Box key={i} style={{
                  padding: tokens.spacing[3],
                  marginBottom: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                }}>
                  <Skeleton width="100%" height="16px" style={{ marginBottom: tokens.spacing[2] }} />
                  <Skeleton width="60%" height="12px" />
                </Box>
              ))}
            </Box>
          </Box>

          {/* Center Column - Ranking Skeleton */}
          <Box className="home-ranking-section">
            {/* Time Range Tabs */}
            <Box className="glass-card" style={{
              display: 'flex',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
            }}>
              {[1, 2, 3].map(i => (
                <Skeleton key={i} width="33%" height="36px" variant="rounded" />
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
