import TopNav from '@/app/components/layout/TopNav'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import SocialComingSoon from './SocialComingSoon'

/**
 * Full page wrapper for the SocialComingSoon component.
 * Used in server components that need to render a complete page
 * when social features are disabled.
 */
export default function SocialComingSoonPage() {
  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <TopNav />
      <SocialComingSoon />
    </Box>
  )
}
