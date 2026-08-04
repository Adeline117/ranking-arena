'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { truncateGraphemes } from '@/lib/utils/truncate'
import Image from 'next/image'
import { useQuery } from '@tanstack/react-query'
import { STALE_SLOW } from '@/lib/hooks/cache-presets'
const getSb = () =>
  import('@/lib/supabase/client').then(
    (m) => m.supabase as import('@supabase/supabase-js').SupabaseClient
  )
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'
import { useDeferredKey } from '@/lib/hooks/useDeferredKey'
import { getCsrfHeaders } from '@/lib/api/client'
import { jwtSubject } from '@/lib/auth/token-subject'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  requestBatchTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'

type HotPost = {
  id: string
  title: string | null
  content: string
  hot_score: number
  like_count: number
  comment_count: number
  author_handle: string | null
  author_avatar_url: string | null
  created_at: string
  translated?: boolean
  translatedTitle?: boolean
  translatedContent?: boolean
}

type TranslatedPostParts = {
  title?: string
  content?: string
}

type TranslationDescriptor = {
  item: BatchTranslationItem
  postId: string
  part: keyof TranslatedPostParts
}

type SidebarTranslationScope = {
  key: string
  targetLang: TranslationTargetLanguage
  accessToken: string
  descriptors: TranslationDescriptor[]
}

type ActiveSidebarTranslation = {
  key: string
  accessToken: string
  sequence: number
  controller: AbortController
  promise: Promise<void>
}

const MAX_TRANSLATION_SNAPSHOTS = 8
const MAX_TRANSLATION_BATCH_SIZE = 20

function needsTranslation(source: string, targetLang: TranslationTargetLanguage): boolean {
  const hasJapaneseKana = /[\u3040-\u30ff]/.test(source)
  const hasKorean = /[\uac00-\ud7af]/.test(source)
  if (targetLang === 'ja') return !hasJapaneseKana
  if (targetLang === 'ko') return !hasKorean
  if (hasJapaneseKana || hasKorean) return true

  const chineseCharacterCount = source.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const nonWhitespaceLength = source.replace(/\s/g, '').length || 1
  const sourceIsChinese = chineseCharacterCount / nonWhitespaceLength > 0.1
  return targetLang === 'en' ? sourceIsChinese : !sourceIsChinese
}

function createTranslationDescriptors(
  posts: readonly HotPost[],
  targetLang: TranslationTargetLanguage
): TranslationDescriptor[] {
  const descriptors: TranslationDescriptor[] = []
  const addPart = (postId: string, part: keyof TranslatedPostParts, source: string | null) => {
    if (!source?.trim() || !needsTranslation(source, targetLang)) return
    descriptors.push({
      item: {
        id: `item-${descriptors.length}`,
        text: source,
        contentType: part === 'title' ? 'post_title' : 'post_content',
        contentId: postId,
        targetLang,
      },
      postId,
      part,
    })
  }

  for (const post of posts) {
    addPart(post.id, 'title', post.title)
    addPart(post.id, 'content', post.content)
  }
  return descriptors
}

function HotTag({ score }: { score: number }) {
  const { t } = useLanguage()
  const level = score >= 100 ? 'hot' : score >= 50 ? 'warm' : 'normal'
  const config = {
    hot: {
      label: t('hotDiscussionsTagHot'),
      bg: 'var(--color-red-subtle)',
      color: 'var(--color-accent-error)',
      border: 'var(--color-red-border)',
    },
    warm: {
      label: t('hotDiscussionsTagRising'),
      bg: 'var(--color-orange-subtle)',
      color: 'var(--color-accent-warning)',
      border: 'var(--color-orange-border)',
    },
    normal: {
      label: t('hotDiscussionsTagActive'),
      bg: 'var(--glass-bg-light)',
      color: 'var(--color-text-tertiary)',
      border: 'var(--glass-border-light)',
    },
  }
  const c = config[level]
  return (
    <span
      style={{
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: tokens.typography.fontWeight.medium,
        color: c.color,
        background: c.bg,
        border: `1px solid ${c.border}`,
        padding: `1px ${tokens.spacing[1.5]}`,
        borderRadius: tokens.radius.full,
        lineHeight: tokens.typography.lineHeight.normal,
        letterSpacing: '0.01em',
        flexShrink: 0,
      }}
    >
      {c.label}
    </span>
  )
}

async function fetchHotPosts(limit: number, signal?: AbortSignal): Promise<HotPost[]> {
  const supabase = await getSb()
  const query = supabase
    .from('posts')
    .select(
      'id, title, content, hot_score, like_count, comment_count, created_at, author_handle, author_avatar_url'
    )
    .gt('hot_score', 0)
    .eq('status', 'active')
    .order('hot_score', { ascending: false })
    .limit(limit)
  const { data, error } = await (signal ? query.abortSignal(signal) : query)

  if (error) throw new Error(`Hot discussions query failed: ${error.message}`)
  if (!data) throw new Error('Hot discussions query returned no data receipt')

  return data.map((p) => ({
    id: p.id,
    title: p.title,
    content: p.content,
    hot_score: p.hot_score,
    like_count: p.like_count,
    comment_count: p.comment_count,
    created_at: p.created_at,
    author_handle: p.author_handle || null,
    author_avatar_url: p.author_avatar_url || null,
    translated: false,
  }))
}

export default function HotDiscussions({ limit = 8 }: { limit?: number }) {
  const { language, t } = useLanguage()
  const { userId, isLoggedIn, authChecked, accessToken, viewerKey, sessionGeneration } =
    useAuthSession()
  const targetLang: TranslationTargetLanguage = language
  const [translationCacheRevision, setTranslationCacheRevision] = useState(0)
  const [translationLoadingKey, setTranslationLoadingKey] = useState<string | null>(null)
  const translationCacheRef = useRef(new Map<string, Record<string, TranslatedPostParts>>())
  const activeTranslationRef = useRef<ActiveSidebarTranslation | null>(null)
  const translationSequenceRef = useRef(0)
  const translationMountedRef = useRef(false)
  const committedTranslationScopeRef = useRef<SidebarTranslationScope | null>(null)

  // Defer query activation until after LCP — prevents simultaneous sidebar fetches from blocking main thread
  const deferredReady = useDeferredKey(true, 1400)

  const {
    data: posts = [],
    isLoading: queryLoading,
    error: swrError,
    refetch,
  } = useQuery({
    queryKey: ['hot-discussions', limit],
    queryFn: ({ signal }) => fetchHotPosts(limit, signal),
    enabled: !!deferredReady,
    refetchOnWindowFocus: false,
    staleTime: STALE_SLOW,
    retry: 3,
    retryDelay: (attempt) => 1000 * Math.pow(2, attempt),
  })
  const loading = !deferredReady || queryLoading

  const resultIdentity = JSON.stringify(posts.map((post) => [post.id, post.title, post.content]))
  const hasUniqueResultIds =
    posts.every((post) => typeof post.id === 'string' && post.id.trim().length > 0) &&
    new Set(posts.map((post) => post.id)).size === posts.length
  const translationDescriptors = useMemo(
    () => createTranslationDescriptors(posts, targetLang),
    [posts, targetLang]
  )
  const translationScope: SidebarTranslationScope | null =
    deferredReady &&
    posts.length > 0 &&
    hasUniqueResultIds &&
    authChecked &&
    isLoggedIn &&
    typeof userId === 'string' &&
    userId.trim().length > 0 &&
    viewerKey === `user:${userId}` &&
    jwtSubject(accessToken)?.toLowerCase() === userId.toLowerCase() &&
    Number.isSafeInteger(sessionGeneration) &&
    sessionGeneration >= 0 &&
    typeof accessToken === 'string' &&
    accessToken.trim()
      ? {
          key: JSON.stringify([
            'sidebar-hot-discussions',
            viewerKey,
            sessionGeneration,
            userId,
            targetLang,
            limit,
            resultIdentity,
          ]),
          targetLang,
          accessToken,
          descriptors: translationDescriptors,
        }
      : null
  const translationScopeKey = translationScope?.key ?? null

  const translatedParts = useMemo(() => {
    if (!translationScope) return {}
    return translationCacheRef.current.get(translationScope.key) ?? {}
    // Ref-backed bounded cache writes are exposed through this revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationCacheRevision, translationScopeKey])
  const translating = translationScope !== null && translationLoadingKey === translationScope.key

  const displayPosts = useMemo(
    () =>
      posts.map((post) => {
        const translated = translatedParts[post.id]
        const translatedTitle = typeof translated?.title === 'string'
        const translatedContent = typeof translated?.content === 'string'
        return {
          ...post,
          title: translated?.title ?? post.title,
          content: translated?.content ?? post.content,
          translatedTitle,
          translatedContent,
          translated: translatedTitle || translatedContent,
        }
      }),
    [posts, translatedParts]
  )

  // Only committed renders may own async publication. Speculative concurrent
  // renders must not invalidate or accept a translation receipt.
  useEffect(() => {
    committedTranslationScopeRef.current = translationScope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, translationScopeKey])

  useEffect(() => {
    const translationCache = translationCacheRef.current
    translationMountedRef.current = true
    return () => {
      translationMountedRef.current = false
      translationSequenceRef.current += 1
      const active = activeTranslationRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Hot discussions translation unmounted', 'AbortError')
        )
      }
      activeTranslationRef.current = null
      translationCache.clear()
    }
  }, [])

  useEffect(() => {
    const scope = committedTranslationScopeRef.current
    if (!scope) {
      const active = activeTranslationRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Hot discussions translation scope closed', 'AbortError')
        )
      }
      activeTranslationRef.current = null
      setTranslationLoadingKey(null)
      return
    }

    if (translationCacheRef.current.has(scope.key)) {
      const active = activeTranslationRef.current
      if (active && active.key !== scope.key && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Hot discussions translation superseded by cache', 'AbortError')
        )
        activeTranslationRef.current = null
      }
      setTranslationLoadingKey(null)
      return
    }

    if (scope.descriptors.length === 0) {
      translationCacheRef.current.set(scope.key, {})
      setTranslationCacheRevision((revision) => revision + 1)
      setTranslationLoadingKey(null)
      return
    }

    const existing = activeTranslationRef.current
    if (existing?.key === scope.key && existing.accessToken === scope.accessToken) return
    if (existing && !existing.controller.signal.aborted) {
      existing.controller.abort(
        new DOMException('Hot discussions translation superseded', 'AbortError')
      )
    }

    const controller = new AbortController()
    const sequence = ++translationSequenceRef.current
    setTranslationLoadingKey(scope.key)

    const promise = (async () => {
      try {
        const batches: BatchTranslationItem[][] = []
        for (let index = 0; index < scope.descriptors.length; index += MAX_TRANSLATION_BATCH_SIZE) {
          batches.push(
            scope.descriptors
              .slice(index, index + MAX_TRANSLATION_BATCH_SIZE)
              .map(({ item }) => item)
          )
        }
        const receipts = await Promise.all(
          batches.map((items) =>
            requestBatchTranslation(items, scope.targetLang, {
              accessToken: scope.accessToken,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            })
          )
        )

        const active = activeTranslationRef.current
        if (
          !translationMountedRef.current ||
          active?.sequence !== sequence ||
          committedTranslationScopeRef.current?.key !== scope.key
        ) {
          return
        }

        const results = Object.assign({}, ...receipts.map((receipt) => receipt.results)) as Record<
          string,
          { translatedText: string; cached: boolean }
        >
        const next: Record<string, TranslatedPostParts> = {}
        for (const descriptor of scope.descriptors) {
          const translatedText = results[descriptor.item.id]?.translatedText
          if (!translatedText || translatedText.trim() === descriptor.item.text.trim()) {
            throw new Error('Hot discussions translation returned an invalid source echo')
          }
          next[descriptor.postId] = {
            ...next[descriptor.postId],
            [descriptor.part]: translatedText,
          }
        }

        translationCacheRef.current.set(scope.key, next)
        while (translationCacheRef.current.size > MAX_TRANSLATION_SNAPSHOTS) {
          const oldestKey = translationCacheRef.current.keys().next().value
          if (typeof oldestKey !== 'string') break
          translationCacheRef.current.delete(oldestKey)
        }
        setTranslationCacheRevision((revision) => revision + 1)
      } catch {
        if (!controller.signal.aborted) {
          controller.abort(
            new DOMException('Hot discussions translation batch failed', 'AbortError')
          )
        }
        // Automatic translation is best-effort and never publishes a partial batch.
      } finally {
        const active = activeTranslationRef.current
        if (active?.sequence === sequence) {
          activeTranslationRef.current = null
          setTranslationLoadingKey((key) => (key === scope.key ? null : key))
        }
      }
    })()

    activeTranslationRef.current = {
      key: scope.key,
      accessToken: scope.accessToken,
      sequence,
      controller,
      promise,
    }

    return () => {
      const active = activeTranslationRef.current
      if (active?.sequence === sequence) {
        if (!controller.signal.aborted) {
          controller.abort(
            new DOMException('Hot discussions translation scope changed', 'AbortError')
          )
        }
        activeTranslationRef.current = null
      }
    }
  }, [accessToken, translationScopeKey])

  const mutate = () => refetch()

  function getTitle(post: HotPost): string {
    const text = (post.title || post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }

  function getContentPreview(post: HotPost): string {
    // Show content preview below title; if title exists, show content; otherwise show more of content
    const raw = (post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    if (post.title) {
      return truncateGraphemes(raw, 100)
    }
    // No title: content already shown as title, show more
    const remaining = raw.slice(60).trim()
    return truncateGraphemes(remaining, 80)
  }

  return (
    <SidebarCard title={t('sidebarHotDiscussions')}>
      {translating && (
        <span role="status" className="sr-only">
          {t('translating')}
        </span>
      )}
      {loading ? (
        <div
          aria-busy={loading || translating}
          style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1.5] }}
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="skeleton"
              style={{ height: 56, borderRadius: tokens.radius.md }}
            />
          ))}
        </div>
      ) : swrError ? (
        <div
          role="alert"
          aria-busy={loading || translating}
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
            textAlign: 'center',
            padding: `${tokens.spacing[4]} 0`,
          }}
        >
          <div>{t('loadFailed')}</div>
          <button
            type="button"
            onClick={() => void mutate()}
            style={{
              marginTop: tokens.spacing[1.5],
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              minWidth: 44,
              minHeight: 44,
              borderRadius: tokens.radius.sm,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: tokens.typography.fontSize.xs,
              cursor: 'pointer',
            }}
          >
            {t('retry')}
          </button>
        </div>
      ) : posts.length === 0 ? (
        <p
          aria-busy={loading || translating}
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
            textAlign: 'center',
            padding: `${tokens.spacing[4]} 0`,
          }}
        >
          {t('sidebarNoDiscussions')}
        </p>
      ) : (
        <div
          aria-busy={loading || translating}
          style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2.5] }}
        >
          {displayPosts.map((post) => {
            const contentPreview = getContentPreview(post)
            const titleWasTranslated = post.title ? post.translatedTitle : post.translatedContent
            return (
              <Link
                key={post.id}
                href={`/post/${post.id}`}
                prefetch={false}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[3.5]}`,
                  borderRadius: tokens.radius.lg,
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: `all ${tokens.transition.fast}`,
                  position: 'relative',
                  minHeight: 44,
                  background: 'var(--glass-bg-light)',
                  border: '1px solid var(--glass-border-light)',
                }}
                onMouseEnter={(e) => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-medium)'
                  el.style.borderColor = 'var(--glass-border-medium)'
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-light)'
                  el.style.borderColor = 'var(--glass-border-light)'
                }}
              >
                {/* Title + hot tag */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[2],
                  }}
                >
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      color: titleWasTranslated
                        ? 'var(--color-translated)'
                        : 'var(--color-text-primary)',
                      lineHeight: tokens.typography.lineHeight.snug,
                      flex: 1,
                      minWidth: 0,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {getTitle(post)}
                  </span>
                  {post.translated && (
                    <span
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.semibold,
                        color: 'var(--color-translated)',
                        background: 'var(--color-translated-08)',
                        border: '1px solid var(--color-translated-20)',
                        padding: `1px ${tokens.spacing[1]}`,
                        borderRadius: tokens.radius.full,
                        lineHeight: tokens.typography.lineHeight.normal,
                        flexShrink: 0,
                      }}
                    >
                      {t('hotTranslatedBadge')}
                    </span>
                  )}
                  <HotTag score={post.hot_score} />
                </div>

                {/* Content preview */}
                {contentPreview && (
                  <p
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: post.translatedContent
                        ? 'var(--color-translated)'
                        : 'var(--color-text-secondary)',
                      opacity: post.translatedContent ? 0.8 : 1,
                      lineHeight: tokens.typography.lineHeight.snug,
                      margin: 0,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {contentPreview}
                  </p>
                )}

                {/* Meta: avatar + author + comments + time */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[1.5],
                    fontSize: tokens.typography.fontSize.xs,
                    color: 'var(--color-text-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  {post.author_avatar_url ? (
                    <Image
                      src={avatarSrc(post.author_avatar_url)}
                      alt={post.author_handle || 'User avatar'}
                      width={18}
                      height={18}
                      unoptimized
                      style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => {
                        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  ) : post.author_handle ? (
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: 'var(--glass-bg-medium)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.semibold,
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {(post.author_handle[0] || '?').toUpperCase()}
                    </div>
                  ) : null}
                  {post.author_handle && (
                    <span
                      style={{
                        fontWeight: tokens.typography.fontWeight.medium,
                        color: 'var(--color-text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        minWidth: 0,
                        flexShrink: 1,
                      }}
                    >
                      {post.author_handle}
                    </span>
                  )}
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[0.5],
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M7 10v12" />
                      <path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88z" />
                    </svg>
                    {post.like_count || 0}
                  </span>
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[0.5],
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    {post.comment_count || 0}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
