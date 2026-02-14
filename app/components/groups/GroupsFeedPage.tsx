'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import TopNav from '@/app/components/layout/TopNav'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import RecommendedGroups from '@/app/components/sidebar/RecommendedGroups'
import NewsFlash from '@/app/components/sidebar/NewsFlash'
import PostFeed from '@/app/components/post/PostFeed'
import { Box, Text } from '@/app/components/base'
import BookCover from '@/app/library/BookCover'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

type SubTabKey = 'following' | 'recommended' | 'bookshelf'

type BookItem = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string | null
}

function BookshelfTab() {
  const { language } = useLanguage()
  const [books, setBooks] = useState<BookItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      const { data } = await supabase
        .from('library_items')
        .select('id, title, author, cover_url, category')
        .order('created_at', { ascending: false })
        .limit(20)
      if (alive) {
        setBooks(data || [])
        setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [])

  if (loading) {
    return (
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: tokens.spacing[3] }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Box key={i} style={{ background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, overflow: 'hidden' }}>
            <div className="skeleton" style={{ width: '100%', aspectRatio: '3/4' }} />
            <Box style={{ padding: tokens.spacing[2] }}>
              <div className="skeleton" style={{ height: 14, width: '80%', marginBottom: 4 }} />
              <div className="skeleton" style={{ height: 12, width: '60%' }} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  }

  // Category colors for type badges
  const categoryColors: Record<string, string> = {
    book: tokens.colors.accent.primary,
    paper: tokens.colors.accent.primary,
    whitepaper: tokens.colors.accent.success,
    event: tokens.colors.accent.warning,
    article: tokens.colors.accent.error,
  }

  if (books.length === 0) {
    return (
      <Box style={{ padding: `${tokens.spacing[12]} ${tokens.spacing[6]}`, textAlign: 'center' }}>
        <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, marginBottom: 16, color: tokens.colors.accent.primary }}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><path d="M8 7h8" /><path d="M8 11h6" />
        </svg>
        <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
          {language === 'zh' ? '书架暂无内容' : 'No books yet'}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4], lineHeight: 1.5 }}>
          {language === 'zh' ? '去书城逛逛吧' : 'Browse the library'}
        </Text>
        <a href="/rankings/resources" style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 24px',
          background: tokens.gradient.primary,
          color: 'var(--color-on-accent)',
          borderRadius: tokens.radius.full,
          fontSize: 14,
          fontWeight: 700,
          textDecoration: 'none',
          boxShadow: `0 4px 12px ${tokens.colors.accent.primary}40`,
          transition: `all ${tokens.transition.base}`,
        }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          {language === 'zh' ? '进入书城' : 'Browse Library'}
        </a>
      </Box>
    )
  }

  return (
    <Box>
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 16 }}>
        {books.map((book) => {
          const typeColor = categoryColors[book.category || ''] || tokens.colors.accent.primary
          return (
            <Link
              key={book.id}
              href={`/library/${book.id}`}
              className="card-hover"
              style={{
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                overflow: 'hidden',
                textDecoration: 'none',
                color: 'inherit',
                border: `1px solid ${tokens.colors.border.primary}`,
                transition: `all 0.25s cubic-bezier(0.4, 0, 0.2, 1)`,
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 2px 8px var(--color-overlay-subtle)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = typeColor + '60'
                e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'
                e.currentTarget.style.boxShadow = `0 8px 24px ${typeColor}20`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.transform = 'none'
                e.currentTarget.style.boxShadow = '0 2px 8px var(--color-overlay-subtle)'
              }}
            >
              {/* Cover */}
              <Box style={{ width: '100%', aspectRatio: '3/4', overflow: 'hidden', position: 'relative' }}>
                <BookCover
                  title={book.title}
                  author={book.author ?? undefined}
                  category={book.category ?? undefined}
                  coverUrl={book.cover_url ?? undefined}
                  fontSize="sm"
                />
                {/* Type badge */}
                {book.category && (
                  <Box style={{
                    position: 'absolute', top: 6, right: 6,
                    background: typeColor + 'DD',
                    color: 'var(--color-on-accent)',
                    fontSize: 10, fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: tokens.radius.sm,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    backdropFilter: 'blur(4px)',
                  }}>
                    {book.category === 'book' ? (language === 'zh' ? '书籍' : 'Book') :
                     book.category === 'paper' ? (language === 'zh' ? '论文' : 'Paper') :
                     book.category === 'whitepaper' ? (language === 'zh' ? '白皮书' : 'WP') :
                     book.category}
                  </Box>
                )}
              </Box>

              {/* Info */}
              <Box style={{ padding: '10px 10px 12px', display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                <Text size="xs" weight="bold" style={{
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                  lineHeight: 1.4,
                }}>
                  {book.title}
                </Text>
                {book.author && (
                  <Text size="xs" color="tertiary" style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontSize: 11,
                  }}>
                    {book.author}
                  </Text>
                )}
                {book.category && (
                  <Text size="xs" color="tertiary" style={{ fontSize: 10, marginTop: 'auto', opacity: 0.7 }}>
                    {book.category}
                  </Text>
                )}
              </Box>
            </Link>
          )
        })}
      </Box>

      {/* View all link */}
      <Box style={{ textAlign: 'center', marginTop: 20 }}>
        <Link href="/rankings/resources" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: tokens.colors.accent.primary,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: tokens.typography.fontSize.sm,
          padding: '10px 24px',
          borderRadius: tokens.radius.full,
          border: `1px solid ${tokens.colors.accent.primary}30`,
          background: `${tokens.colors.accent.primary}08`,
          transition: `all ${tokens.transition.base}`,
        }}>
          {language === 'zh' ? '查看全部书库' : 'View full library'}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </Link>
      </Box>
    </Box>
  )
}

export default function GroupsFeedPage() {
  const { language: _language, t } = useLanguage()
  const { email, userId } = useAuthSession()
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [_loadingGroups, setLoadingGroups] = useState(true)
  const [subTab, setSubTab] = useState<SubTabKey>('recommended')

  // Load user's joined groups
  useEffect(() => {
    if (!userId) {
      setLoadingGroups(false)
      return
    }

    const loadMyGroups = async () => {
      try {
        const { data: memberships } = await supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', userId)

        if (!memberships || memberships.length === 0) {
          setMyGroups([])
          setLoadingGroups(false)
          return
        }

        const groupIds = memberships.map((m) => m.group_id)
        const { data: groupsData } = await supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .in('id', groupIds)

        setMyGroups(groupsData || [])
      } catch (err) {
        logger.error('Failed to load groups:', err)
      } finally {
        setLoadingGroups(false)
      }
    }

    loadMyGroups()
  }, [userId])

  const myGroupIds = myGroups.map(g => g.id)

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <ThreeColumnLayout
        leftSidebar={
          <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />}>
            <RecommendedGroups />
          </Suspense>
        }
        rightSidebar={
          <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />}>
            <NewsFlash />
          </Suspense>
        }
      >
        {/* Tabs: 关注 / 推荐 / 书架 */}
        <Box style={{
          display: 'flex',
          gap: tokens.spacing[5],
          marginBottom: tokens.spacing[4],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          paddingBottom: 0,
        }}>
          {([
            { key: 'following' as SubTabKey, label: t('following') },
            { key: 'recommended' as SubTabKey, label: t('recommended') },
            { key: 'bookshelf' as SubTabKey, label: t('bookshelf') || '书架' },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              style={{
                padding: `${tokens.spacing[2]} 0 ${tokens.spacing[2]}`,
                border: 'none',
                background: 'transparent',
                color: subTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                fontWeight: subTab === tab.key ? 700 : 500,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                borderBottom: subTab === tab.key ? `2.5px solid ${tokens.colors.accent.primary}` : '2.5px solid transparent',
                transition: `all ${tokens.transition.base}`,
                marginBottom: '-1px',
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {subTab === 'following' && (
          myGroups.length > 0 ? (
            <PostFeed layout="masonry" groupIds={myGroupIds} />
          ) : (
            <Box style={{ padding: `${tokens.spacing[12]} ${tokens.spacing[6]}`, textAlign: 'center', background: tokens.colors.bg.secondary, borderRadius: tokens.radius.xl, border: `1px solid ${tokens.colors.border.primary}` }}>
              <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, marginBottom: 16, color: tokens.colors.accent.primary }}>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                {_language === 'zh' ? '还没有关注的小组' : 'No groups followed yet'}
              </Text>
              <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
                {t('joinGroupsToSeePosts')}
              </Text>
            </Box>
          )
        )}

        {subTab === 'recommended' && (
          <PostFeed layout="masonry" />
        )}

        {subTab === 'bookshelf' && (
          <BookshelfTab />
        )}
      </ThreeColumnLayout>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
