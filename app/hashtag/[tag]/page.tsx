'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box, Text } from '@/app/components/base'
import PostFeed from '@/app/components/post/PostFeed'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

export default function HashtagPage() {
  const { tag } = useParams<{ tag: string }>()
  const { t } = useLanguage()
  const { email } = useAuthSession()
  const decodedTag = decodeURIComponent(tag || '')

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 700, margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`, paddingBottom: 80 }}>
        {/* Header */}
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          padding: `${tokens.spacing[3]} 0`,
        }}>
          <Text size="lg" weight="bold" style={{ color: 'var(--color-brand)' }}>
            #{decodedTag}
          </Text>
        </Box>

        {/* Post feed filtered by hashtag - uses the PostFeed with custom fetch */}
        <HashtagPostFeed tag={decodedTag} />
      </Box>
      <MobileBottomNav />
    </Box>
  )
}

/**
 * Fetch posts by hashtag and display them.
 */
function HashtagPostFeed({ tag }: { tag: string }) {
  const { t, language } = useLanguage()
  const [posts, setPosts] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/hashtags/${encodeURIComponent(tag)}?limit=50&sort_by=created_at`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error?.message || 'Failed to load')
        setPosts(data.data?.posts || [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [tag])

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center', color: tokens.colors.text.tertiary }}>
        {t('loading')}...
      </Box>
    )
  }

  if (error) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center', color: tokens.colors.accent.error }}>
        {error}
      </Box>
    )
  }

  if (posts.length === 0) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center', color: tokens.colors.text.tertiary }}>
        {t('noPostsYet')}
      </Box>
    )
  }

  // Reuse PostFeed with initialPosts
  return <PostFeed initialPosts={posts} showSortButtons={false} />
}
