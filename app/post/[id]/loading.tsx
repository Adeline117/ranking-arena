import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'

export default function PostLoading() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box style={{ width: '70%', height: 28, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[4], opacity: 0.7 }} />
        <Box style={{ width: '40%', height: 16, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[6], opacity: 0.5 }} />
        {[1, 2, 3, 4].map(i => (
          <Box key={i} style={{ width: '100%', height: 16, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, marginBottom: tokens.spacing[2], opacity: 0.4 + i * 0.05 }} />
        ))}
      </Box>
    </Box>
  )
}
