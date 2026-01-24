'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import TopNav from '@/app/components/layout/TopNav'
import DesktopSidebar from '@/app/components/layout/DesktopSidebar'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import PostFeed from '@/app/components/post/PostFeed'
import { Box, Text, Button } from '@/app/components/base'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

export default function GroupsFeedPage() {
  const { language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
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

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      {/* Desktop sidebar */}
      <div className="hide-mobile hide-tablet">
        <DesktopSidebar />
      </div>

      {/* Main content */}
      <Box
        as="main"
        className="feed-main-content"
        style={{
          maxWidth: 680,
          margin: '0 auto',
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
          paddingBottom: 100,
        }}
      >
        {/* My Groups - Horizontal scrollable */}
        <Box style={{ marginBottom: tokens.spacing[5] }}>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[3] }}>
            <Text size="lg" weight="bold">
              {language === 'zh' ? '我的小组' : 'My Groups'}
            </Text>
            <Link
              href="/groups/discover"
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.accent.primary,
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              {language === 'zh' ? '发现更多' : 'Discover'}
            </Link>
          </Box>

          {loadingGroups ? (
            <Text size="sm" color="tertiary">{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
          ) : myGroups.length === 0 ? (
            <Box
              style={{
                padding: tokens.spacing[5],
                textAlign: 'center',
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                {language === 'zh' ? '还未加入任何小组' : 'Not joined any groups yet'}
              </Text>
              <Link href="/groups/discover">
                <Button variant="primary" size="sm">
                  {language === 'zh' ? '发现小组' : 'Discover Groups'}
                </Button>
              </Link>
            </Box>
          ) : (
            <Box
              style={{
                display: 'flex',
                gap: tokens.spacing[3],
                overflowX: 'auto',
                paddingBottom: tokens.spacing[2],
                scrollSnapType: 'x mandatory',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {myGroups.map((group) => (
                <Link
                  key={group.id}
                  href={`/groups/${group.id}`}
                  style={{
                    flexShrink: 0,
                    width: 120,
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    textDecoration: 'none',
                    color: tokens.colors.text.primary,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    scrollSnapAlign: 'start',
                    transition: `all ${tokens.transition.base}`,
                  }}
                >
                  <Box
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: tokens.radius.lg,
                      background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))',
                      border: `1px solid ${tokens.colors.border.primary}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {group.avatar_url ? (
                      <img src={group.avatar_url} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <Text size="base" weight="bold" style={{ color: '#c9b8db' }}>
                        {group.name.charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </Box>
                  <Text
                    size="xs"
                    weight="bold"
                    style={{
                      textAlign: 'center',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      width: '100%',
                    }}
                  >
                    {group.name}
                  </Text>
                  {group.member_count != null && (
                    <Text size="xs" color="tertiary">
                      {group.member_count} {language === 'zh' ? '人' : 'members'}
                    </Text>
                  )}
                </Link>
              ))}
            </Box>
          )}
        </Box>

        {/* Group feed - posts from joined groups */}
        <Box>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            {language === 'zh' ? '小组动态' : 'Group Posts'}
          </Text>
          {myGroups.length > 0 ? (
            <PostFeed
              layout="masonry"
              groupIds={myGroups.map((g) => g.id)}
            />
          ) : (
            <Box
              style={{
                padding: tokens.spacing[6],
                textAlign: 'center',
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Text size="sm" color="tertiary">
                {language === 'zh' ? '加入小组后，这里会显示小组内的帖子' : 'Join groups to see their posts here'}
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
