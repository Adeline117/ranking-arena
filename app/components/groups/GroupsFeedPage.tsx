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
import Image from 'next/image'

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
  cover_image_url: string | null
  type: string | null
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
        .select('id, title, author, cover_image_url, type, category')
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

  return (
    <Box>
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: tokens.spacing[3] }}>
        {books.map((book) => (
          <Link
            key={book.id}
            href={`/library/${book.id}`}
            style={{
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              overflow: 'hidden',
              textDecoration: 'none',
              color: 'inherit',
              border: `1px solid ${tokens.colors.border.primary}`,
              transition: `all ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = tokens.colors.accent.primary; e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary; e.currentTarget.style.transform = 'translateY(0)' }}
          >
            <Box style={{ width: '100%', aspectRatio: '3/4', background: tokens.colors.bg.tertiary, position: 'relative', overflow: 'hidden' }}>
              {book.cover_image_url ? (
                <Image src={book.cover_image_url} alt={book.title} fill style={{ objectFit: 'cover' }} unoptimized />
              ) : (
                <Box style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: tokens.spacing[2] }}>
                  <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', lineHeight: 1.3 }}>
                    {book.title.slice(0, 30)}
                  </Text>
                </Box>
              )}
            </Box>
            <Box style={{ padding: tokens.spacing[2] }}>
              <Text size="xs" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {book.title}
              </Text>
              {book.author && (
                <Text size="xs" color="tertiary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                  {book.author}
                </Text>
              )}
            </Box>
          </Link>
        ))}
      </Box>
      <Box style={{ textAlign: 'center', marginTop: tokens.spacing[4] }}>
        <Link href="/library" style={{
          color: tokens.colors.accent.primary,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: tokens.typography.fontSize.sm,
        }}>
          {language === 'zh' ? '查看全部书库 →' : 'View full library →'}
        </Link>
      </Box>
    </Box>
  )
}

export default function GroupsFeedPage() {
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTabKey>('recommended')
  const [activeTab, setActiveTab] = useState<'feed' | 'discover'>('feed')
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [loadingDiscover, setLoadingDiscover] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

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
        console.error('Failed to load groups:', err)
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
          <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
            <RecommendedGroups />
          </Suspense>
        }
        rightSidebar={
          <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
            <NewsFlash />
          </Suspense>
        }
      >
        {/* Tabs: 关注 / 推荐 / 书架 */}
        <Box style={{
          display: 'flex',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          paddingBottom: tokens.spacing[2],
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
                padding: `${tokens.spacing[1]} 0`,
                border: 'none',
                background: 'transparent',
                color: subTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                fontWeight: subTab === tab.key ? 700 : 400,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                borderBottom: subTab === tab.key ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {subTab === 'following' && (
          myGroups.length > 0 ? (
            <PostFeed layout="list" groupIds={myGroupIds} />
          ) : (
            <Box style={{ padding: tokens.spacing[6], textAlign: 'center', background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
              <Text size="sm" color="tertiary">{t('joinGroupsToSeePosts')}</Text>
            </Box>
          )
        )}

        {subTab === 'recommended' && (
          <PostFeed layout="list" />
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
