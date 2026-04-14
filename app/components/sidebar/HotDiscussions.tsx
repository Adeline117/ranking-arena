'use client'

import Link from 'next/link'
import Image from 'next/image'
import useSWR from 'swr'
// Supabase: dynamic import — only used for auth check in translate call (non-critical)
const getSb = () => import('@/lib/supabase/client').then(m => m.supabase as import('@supabase/supabase-js').SupabaseClient)
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'
import { useDeferredKey } from '@/lib/hooks/useDeferredSWR'

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
    <span style={{
      fontSize: tokens.typography.fontSize.xs,
      fontWeight: tokens.typography.fontWeight.medium,
      color: c.color,
      background: c.bg,
      border: `1px solid ${c.border}`,
      padding: '1px 6px',
      borderRadius: tokens.radius.full,
      lineHeight: tokens.typography.lineHeight.normal,
      letterSpacing: '0.01em',
      flexShrink: 0,
    }}>
      {c.label}
    </span>
  )
}

async function fetchHotPosts(_key: string, limit: number, targetLang?: string): Promise<HotPost[]> {
  const supabase = await getSb()
  const { data } = await supabase
    .from('posts')
    .select('id, title, content, hot_score, like_count, comment_count, created_at, author_handle, author_avatar_url')
    .gt('hot_score', 0)
    .eq('status', 'active')
    .order('hot_score', { ascending: false })
    .limit(limit)

  if (!data) return []

  const posts: HotPost[] = data.map(p => ({
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

  // If viewing in non-source language, fetch translations from cache
  if (targetLang) {
    const postIds = posts.map((p: HotPost) => p.id)
    const { data: titleCache } = await supabase
      .from('translation_cache')
      .select('content_id, translated_text')
      .eq('content_type', 'post_title')
      .eq('target_lang', targetLang)
      .in('content_id', postIds)
    const { data: contentCache } = await supabase
      .from('translation_cache')
      .select('content_id, translated_text')
      .eq('content_type', 'post_content')
      .eq('target_lang', targetLang)
      .in('content_id', postIds)

    const titleMap = new Map<string, string>((titleCache || []).map((t: { content_id: string; translated_text: string }) => [t.content_id, t.translated_text]))
    const contentMap = new Map<string, string>((contentCache || []).map((t: { content_id: string; translated_text: string }) => [t.content_id, t.translated_text]))

    // Apply cached translations
    const needsTranslation: Array<{ id: string; text: string; contentType: string; contentId: string }> = []
    for (const p of posts) {
      let wasTranslated = false
      if (titleMap.has(p.id)) {
        p.title = titleMap.get(p.id)!
        wasTranslated = true
      } else if (p.title) {
        needsTranslation.push({ id: `t-${p.id}`, text: p.title, contentType: 'post_title', contentId: p.id })
      }
      if (contentMap.has(p.id)) {
        p.content = contentMap.get(p.id)!
        wasTranslated = true
      } else if (p.content) {
        needsTranslation.push({ id: `c-${p.id}`, text: p.content, contentType: 'post_content', contentId: p.id })
      }
      if (wasTranslated) p.translated = true
    }

    // Fire-and-forget: translate uncached posts in background (requires auth)
    if (needsTranslation.length > 0) {
      getSb().then(sb => sb.auth.getSession()).then(({ data }) => {
        if (!data.session) return // Skip translate for unauthenticated users (avoids 401)
        fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: needsTranslation.slice(0, 20), targetLang }),
        }).catch(() => {}) // Silently fail — translation is non-critical
      })
    }
  }

  return posts
}

export default function HotDiscussions({ limit = 8 }: { limit?: number }) {
  const { language, t } = useLanguage()

  const targetLang = language
  // Defer SWR key until after LCP — prevents simultaneous sidebar fetches from blocking main thread
  const immediateKey = ['hot-discussions', limit, language] as const
  const swrKey = useDeferredKey(immediateKey, 1400)

  const { data: posts = [], isLoading: loading, error: swrError, mutate } = useSWR(
    swrKey,
    ([key, lim, _lang]) => fetchHotPosts(key, lim, targetLang),
    {
      revalidateOnFocus: false,
      dedupingInterval: 180000,
      errorRetryCount: 3,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return
        setTimeout(() => revalidate({ retryCount }), 1000 * Math.pow(2, retryCount))
      },
    }
  )

  function getTitle(post: HotPost): string {
    const text = (post.title || post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }

  function getContentPreview(post: HotPost): string {
    // Show content preview below title; if title exists, show content; otherwise show more of content
    const raw = (post.content || '').replace(/\[sticker:\w+\]/g, '').trim()
    if (post.title) {
      return raw.length > 100 ? raw.slice(0, 100) + '...' : raw
    }
    // No title: content already shown as title, show more
    const remaining = raw.slice(60).trim()
    return remaining.length > 80 ? remaining.slice(0, 80) + '...' : remaining
  }

  return (
    <SidebarCard title={t('sidebarHotDiscussions')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 56, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : swrError ? (
        <div style={{
          fontSize: tokens.typography.fontSize.sm,
          color: 'var(--color-text-tertiary)',
          textAlign: 'center',
          padding: `${tokens.spacing[4]} 0`,
        }}>
          <div>{t('loadFailed')}</div>
          <button
            onClick={() => mutate()}
            style={{ marginTop: 6, padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.sm, border: '1px solid var(--glass-border-light)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: tokens.typography.fontSize.xs, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : posts.length === 0 ? (
        <p style={{
          fontSize: tokens.typography.fontSize.sm,
          color: 'var(--color-text-tertiary)',
          textAlign: 'center',
          padding: `${tokens.spacing[4]} 0`,
        }}>
          {t('sidebarNoDiscussions')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.map((post) => {
            const contentPreview = getContentPreview(post)
            return (
              <Link
                key={post.id}
                href={`/post/${post.id}`}
                prefetch={false}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '12px 14px',
                  borderRadius: tokens.radius.lg,
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: `all ${tokens.transition.fast}`,
                  position: 'relative',
                  background: 'var(--glass-bg-light)',
                  border: '1px solid var(--glass-border-light)',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-medium)'
                  el.style.borderColor = 'var(--glass-border-medium)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget
                  el.style.background = 'var(--glass-bg-light)'
                  el.style.borderColor = 'var(--glass-border-light)'
                }}
              >
                {/* Title + hot tag */}
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                }}>
                  <span style={{
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: post.translated ? 'var(--color-translated)' : 'var(--color-text-primary)',
                    lineHeight: tokens.typography.lineHeight.snug,
                    flex: 1,
                    minWidth: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {getTitle(post)}
                  </span>
                  {post.translated && (
                    <span style={{
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      color: 'var(--color-translated)',
                      background: 'var(--color-translated-08)',
                      border: '1px solid var(--color-translated-20)',
                      padding: '1px 5px',
                      borderRadius: tokens.radius.full,
                      lineHeight: tokens.typography.lineHeight.normal,
                      flexShrink: 0,
                    }}>译</span>
                  )}
                  <HotTag score={post.hot_score} />
                </div>

                {/* Content preview */}
                {contentPreview && (
                  <p style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: post.translated ? 'var(--color-translated)' : 'var(--color-text-secondary)',
                    opacity: post.translated ? 0.8 : 1,
                    lineHeight: tokens.typography.lineHeight.snug,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {contentPreview}
                  </p>
                )}

                {/* Meta: avatar + author + comments + time */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-tertiary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}>
                  {post.author_avatar_url ? (
                    <Image
                      src={`/api/avatar?url=${encodeURIComponent(post.author_avatar_url)}`}
                      alt={post.author_handle || 'User avatar'}
                      width={18}
                      height={18}
                      unoptimized
                      style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    />
                  ) : post.author_handle ? (
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--glass-bg-medium)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.semibold, color: 'var(--color-text-secondary)',
                    }}>
                      {(post.author_handle[0] || '?').toUpperCase()}
                    </div>
                  ) : null}
                  {post.author_handle && (
                    <span style={{
                      fontWeight: tokens.typography.fontWeight.medium,
                      color: 'var(--color-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      minWidth: 0,
                      flexShrink: 1,
                    }}>
                      {post.author_handle}
                    </span>
                  )}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10v12"/><path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88z"/></svg>
                    {post.like_count || 0}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
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
