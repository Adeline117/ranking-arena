'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'

export default function NewsTimelineSkeleton() {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Box key={i} style={{
          display: 'flex', borderLeft: `2px solid ${tokens.colors.border.primary}`,
          paddingLeft: tokens.spacing[3], position: 'relative',
        }}>
          <Box style={{
            position: 'absolute', left: '-7px', top: tokens.spacing[3],
            width: 12, height: 12, borderRadius: '50%',
            background: tokens.colors.bg.tertiary, border: `2.5px solid ${tokens.colors.bg.primary}`,
          }} />
          <Box style={{ flex: 1 }}>
            <Box style={{
              padding: tokens.spacing[4], borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
            }}>
              <Box className="skeleton" style={{ height: 14, width: '30%', borderRadius: 6, marginBottom: tokens.spacing[2] }} />
              <Box className="skeleton" style={{ height: 18, width: '90%', borderRadius: 6, marginBottom: tokens.spacing[2] }} />
              <Box className="skeleton" style={{ height: 14, width: '70%', borderRadius: 6 }} />
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
