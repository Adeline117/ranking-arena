'use client'

import { tokens } from '@/lib/design-tokens'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box } from '@/app/components/base'
import PageHeader from '@/app/components/ui/PageHeader'
import PostFeed from '@/app/components/post/PostFeed'

interface HashtagClientProps {
  tag: string
}

export default function HashtagClient({ tag }: HashtagClientProps) {
  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          maxWidth: 700,
          margin: '0 auto',
          padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`,
          paddingBottom: 80,
        }}
      >
        {/* Header */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
            padding: `${tokens.spacing[3]} 0`,
          }}
        >
          <PageHeader title={<span style={{ color: 'var(--color-brand)' }}>#{tag}</span>} compact />
        </Box>

        {/* Post feed scoped to this hashtag — PostFeed paginates /api/hashtags/[tag] so
            infinite scroll only ever appends posts containing #tag (no global leak). */}
        <PostFeed tag={tag} showSortButtons={false} />
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
