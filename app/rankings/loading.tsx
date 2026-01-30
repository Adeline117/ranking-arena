import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'

export default function RankingsLoading() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box style={{ width: 200, height: 28, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[4], opacity: 0.7 }} />
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          {[1, 2, 3, 4].map(i => (
            <Box key={i} style={{ width: 80, height: 36, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary, opacity: 0.5 }} />
          ))}
        </Box>
        <RankingSkeleton />
      </Box>
    </Box>
  )
}
