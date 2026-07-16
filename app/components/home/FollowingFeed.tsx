'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import PostCard from '@/app/components/post/components/PostCard'
import type { PostWithUserState } from '@/lib/types'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

function getAccessTokenSubject(token: string): string | null {
  try {
    const encodedPayload = token.split('.')[1]
    if (!encodedPayload) return null
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** Score posts by freshness (10h half-life) + engagement */
function calculateFeedScore(post: PostWithUserState): number {
  const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3600000
  const freshness = Math.exp(-0.1 * ageHours)
  const engagement =
    (post.like_count || 0) * 2 + (post.comment_count || 0) * 3 + (post.repost_count || 0) * 4
  return freshness * 100 + engagement
}

// prettier-ignore
export default function FollowingFeed() {
  const { user, accessToken, loading: authLoading } = useAuthSession()
  const { t } = useLanguage()
  const [posts, setPosts] = useState<PostWithUserState[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [followingCount, setFollowingCount] = useState(0)
  const [stateOwner, setStateOwner] = useState<string | null>(null)
  const viewerScope = user?.id ?? null
  const viewerScopeRef = useRef(viewerScope)
  const accessTokenRef = useRef(accessToken)
  const authLoadingRef = useRef(authLoading)
  const requestGenerationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Update ownership refs during render. A response for viewer A can therefore
  // be rejected immediately after a render for viewer B, before effects run.
  viewerScopeRef.current = viewerScope
  accessTokenRef.current = accessToken
  authLoadingRef.current = authLoading

  const fetchFollowingPosts = useCallback(async () => {
    const requestOwner = viewerScopeRef.current
    const requestToken = accessTokenRef.current
    if (authLoadingRef.current || !requestOwner || !requestToken) return

    const requestGeneration = ++requestGenerationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStateOwner(requestOwner)
    setPosts([])
    setFollowingCount(0)
    setLoading(true)
    setError(false)
    try {
      if (getAccessTokenSubject(requestToken) !== requestOwner) {
        throw new Error('Following feed token owner mismatch')
      }

      const requestFeed = (token: string) =>
        fetch('/api/posts?sort_by=following&limit=30', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal: controller.signal,
        })

      let response = await requestFeed(requestToken)
      if (response.status === 401) {
        if (
          requestGeneration !== requestGenerationRef.current ||
          requestOwner !== viewerScopeRef.current
        ) return

        const refreshedToken = await tokenRefreshCoordinator.forceRefresh()
        if (
          requestGeneration !== requestGenerationRef.current ||
          requestOwner !== viewerScopeRef.current
        ) return
        if (!refreshedToken || getAccessTokenSubject(refreshedToken) !== requestOwner) {
          throw new Error('Following feed token refresh did not preserve viewer')
        }

        response = await requestFeed(refreshedToken)
      }

      const body = (await response.json()) as {
        success?: boolean
        data?: { posts?: PostWithUserState[]; following_count?: number; viewer_id?: string }
      }
      const responsePosts = body.data?.posts
      const responseFollowingCount = body.data?.following_count

      if (
        !response.ok ||
        body.success !== true ||
        !Array.isArray(responsePosts) ||
        typeof responseFollowingCount !== 'number' ||
        !Number.isSafeInteger(responseFollowingCount) ||
        responseFollowingCount < 0 ||
        body.data?.viewer_id !== requestOwner
      ) {
        throw new Error(`Following feed request failed (${response.status})`)
      }

      if (
        requestGeneration !== requestGenerationRef.current ||
        requestOwner !== viewerScopeRef.current
      )
        return

      // Score and sort by relevance (freshness + engagement)
      const scoredPosts = [...responsePosts].sort(
        (a, b) => calculateFeedScore(b) - calculateFeedScore(a)
      )
      setFollowingCount(responseFollowingCount)
      setPosts(scoredPosts)
    } catch (e) {
      if (
        controller.signal.aborted ||
        requestGeneration !== requestGenerationRef.current ||
        requestOwner !== viewerScopeRef.current
      )
        return
      logger.error('Failed to fetch following feed:', e)
      setError(true)
    } finally {
      if (
        requestGeneration === requestGenerationRef.current &&
        requestOwner === viewerScopeRef.current
      ) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!viewerScope || !accessToken) {
      requestGenerationRef.current += 1
      abortRef.current?.abort()
      setStateOwner(null)
      setPosts([])
      setFollowingCount(0)
      setError(false)
      setLoading(false)
      return
    }

    void fetchFollowingPosts()
    return () => {
      requestGenerationRef.current += 1
      abortRef.current?.abort()
    }
  }, [viewerScope, accessToken, authLoading, fetchFollowingPosts])

  const stateIsCurrent = stateOwner === viewerScope
  const visiblePosts = stateIsCurrent ? posts : []
  const visibleFollowingCount = stateIsCurrent ? followingCount : 0
  const visibleError = stateIsCurrent && error
  const visibleLoading =
    authLoading || (!!user && !accessToken) || (!!viewerScope && (!stateIsCurrent || loading))

  // Not logged in
  if (!authLoading && !user) {
    return (
      <div style={{
        textAlign: 'center', padding: `${tokens.spacing[16]} ${tokens.spacing[5]}`,
        color: tokens.colors.text.secondary,
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>--</div>
        <p style={{ fontSize: 16, marginBottom: 12 }}>
          {t('followingFeedLoginPrompt')}
        </p>
        <button onClick={() => useLoginModal.getState().openLoginModal()} style={{
          display: 'inline-block', padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`, borderRadius: tokens.radius.md,
          background: tokens.colors.accent.brand, color: tokens.colors.white,
          border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
        }}>
          {t('followingFeedLoginButton')}
        </button>
      </div>
    )
  }

  if (visibleLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[1, 2, 3].map(i => (
          <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
        ))}
      </div>
    )
  }

  if (visibleError) {
    return (
      <div style={{
        textAlign: 'center', padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`,
        color: tokens.colors.text.tertiary,
      }}>
        <p style={{ fontSize: 14, marginBottom: 8 }}>{t('loadFailed')}</p>
        <button
          onClick={fetchFollowingPosts}
          style={{
            fontSize: 13, color: tokens.colors.accent.brand,
            background: 'transparent', border: 'none',
            textDecoration: 'underline', cursor: 'pointer',
          }}
        >
          {t('retry')}
        </button>
      </div>
    )
  }

  // No following
  if (visibleFollowingCount === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: `${tokens.spacing[16]} ${tokens.spacing[5]}`,
        color: tokens.colors.text.secondary,
      }}>
        <Image src="/stickers/happy.webp" alt="No posts yet" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
        <p style={{ fontSize: 16, marginBottom: 8 }}>
          {t('followingFeedNoFollowing')}
        </p>
        <p style={{ fontSize: 13 }}>
          {t('followingFeedDiscoverTraders')}
        </p>
        <Link href="/rankings" style={{
          display: 'inline-block', marginTop: 16, padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`, borderRadius: tokens.radius.md,
          background: tokens.colors.accent.brand, color: tokens.colors.white,
          textDecoration: 'none', fontWeight: 600, fontSize: 14,
        }}>
          {t('followingFeedViewRankings')}
        </Link>
      </div>
    )
  }

  if (visiblePosts.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: `${tokens.spacing[16]} ${tokens.spacing[5]}`,
        color: tokens.colors.text.secondary,
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>--</div>
        <p>{t('followingFeedNoPosts')}</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {visiblePosts.map(post => (
        <PostCard key={post.id} post={post} variant="compact" />
      ))}
    </div>
  )
}
