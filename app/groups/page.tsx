'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState, Suspense, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import PopularTradersWidget from '@/app/components/sidebar/PopularTraders'
import RecommendedGroupsWidget from '@/app/components/sidebar/RecommendedGroups'
import MyGroupsWidget from '@/app/components/sidebar/MyGroups'
import NewsFlashWidget from '@/app/components/sidebar/NewsFlash'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'

interface Group {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  cover_url?: string | null
  member_count?: number | null
  description?: string | null
  description_en?: string | null
}

type GroupTab = 'all' | 'mine' | 'hot'

function GroupWaterfallCard({ group, language }: { group: Group; language: string }) {
  const displayName = language === 'zh' ? group.name : (group.name_en || group.name)
  const description = language === 'zh' ? group.description : (group.description_en || group.description)

  return (
    <Link
      href={`/groups/${group.id}`}
      className="glass-card"
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        borderRadius: tokens.radius.xl,
        overflow: 'hidden',
        transition: tokens.transition.base,
      }}
    >
      {/* Cover / Avatar area */}
      <div style={{
        width: '100%',
        aspectRatio: group.cover_url ? undefined : '1 / 0.75',
        minHeight: 80,
        background: tokens.gradient.primarySubtle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {group.cover_url ? (
          <Image
            src={group.cover_url}
            alt={displayName}
            width={300}
            height={200}
            style={{ width: '100%', height: 'auto', objectFit: 'cover' }}
            unoptimized
          />
        ) : group.avatar_url ? (
          <Image
            src={group.avatar_url}
            alt={displayName}
            width={64}
            height={64}
            style={{
              width: 64,
              height: 64,
              borderRadius: tokens.radius.lg,
              objectFit: 'cover',
              border: `2px solid ${tokens.colors.border.primary}`,
            }}
            unoptimized
          />
        ) : (
          <div style={{
            width: 56,
            height: 56,
            borderRadius: tokens.radius.lg,
            background: tokens.gradient.primary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: tokens.typography.fontWeight.black,
            color: '#fff',
          }}>
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: tokens.spacing[4] }}>
        <Text
          size="sm"
          weight="bold"
          style={{
            marginBottom: tokens.spacing[1],
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: tokens.colors.text.primary,
          }}
        >
          {displayName}
        </Text>

        {group.member_count != null && (
          <Text size="xs" color="tertiary" style={{ marginBottom: description ? tokens.spacing[2] : 0 }}>
            {group.member_count.toLocaleString()} {language === 'zh' ? '成员' : 'members'}
          </Text>
        )}

        {description && (
          <Text
            size="xs"
            color="secondary"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: tokens.typography.lineHeight.normal,
            }}
          >
            {description}
          </Text>
        )}
      </div>
    </Link>
  )
}

function GroupsWaterfall() {
  const { t, language } = useLanguage()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<GroupTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [userId, setUserId] = useState<string | null>(null)
  const [myGroupIds, setMyGroupIds] = useState<string[]>([])

  const escapeIlike = useCallback((s: string) => s.replace(/[%_\\]/g, c => `\\${c}`), [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id ?? null
      setUserId(uid)
      if (uid) {
        supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', uid)
          .then(({ data: memberships }) => setMyGroupIds((memberships || []).map(m => m.group_id)))
      }
    })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    async function loadGroups() {
      setLoading(true)
      try {
        if (activeTab === 'mine' && myGroupIds.length === 0) {
          setGroups([])
          setLoading(false)
          return
        }

        let query = supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count, description, description_en')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(40)

        if (activeTab === 'mine') query = query.in('id', myGroupIds)
        if (debouncedQuery) {
          query = query.or(`name.ilike.%${escapeIlike(debouncedQuery)}%,name_en.ilike.%${escapeIlike(debouncedQuery)}%`)
        }

        const { data } = await query
        setGroups(data || [])
      } catch {
        setGroups([])
      } finally {
        setLoading(false)
      }
    }
    loadGroups()
  }, [debouncedQuery, activeTab, myGroupIds, escapeIlike])

  const tabLabels: Record<GroupTab, string> = {
    all: language === 'zh' ? '全部' : 'All',
    mine: language === 'zh' ? '我的' : 'Mine',
    hot: language === 'zh' ? '热门' : 'Hot',
  }

  return (
    <div>
      {/* Search + Tabs */}
      <div style={{ marginBottom: tokens.spacing[5] }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={language === 'zh' ? '搜索小组...' : 'Search groups...'}
          className="touch-target"
          style={{
            width: '100%',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.glass.bg.light,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.base,
            marginBottom: tokens.spacing[3],
            outline: 'none',
            minHeight: 44,
          }}
        />

        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {(['all', 'mine', 'hot'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.full,
                border: 'none',
                cursor: 'pointer',
                background: activeTab === tab ? `${tokens.colors.accent.primary}20` : 'transparent',
                color: activeTab === tab ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeTab === tab ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                transition: tokens.transition.fast,
                minHeight: 44,
              }}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </div>
      </div>

      {/* Waterfall Grid */}
      {loading ? (
        <div className="waterfall-grid">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} style={{
              borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.secondary,
              height: 120 + (i % 3) * 40,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: tokens.spacing[12] }}>
          <Text size="md" color="tertiary">
            {debouncedQuery
              ? (language === 'zh' ? '未找到匹配的小组' : 'No groups found')
              : activeTab === 'mine'
                ? (language === 'zh' ? '还未加入任何小组' : 'Not joined any groups')
                : (language === 'zh' ? '暂无小组' : 'No groups available')}
          </Text>
        </div>
      ) : (
        <div className="waterfall-grid">
          {groups.map(group => (
            <GroupWaterfallCard key={group.id} group={group} language={language} />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupsContent() {
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1400, margin: '0 auto' }}>
        <ThreeColumnLayout
          leftSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <PopularTradersWidget />
              <RecommendedGroupsWidget />
            </div>
          }
          rightSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <MyGroupsWidget />
              <NewsFlashWidget />
            </div>
          }
        >
          <GroupsWaterfall />
        </ThreeColumnLayout>
      </Box>
    </Box>
  )
}

export default function GroupsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <GroupsContent />
    </Suspense>
  )
}
