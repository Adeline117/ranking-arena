'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import UserHomeLayout from '@/app/components/trader/UserHomeLayout'
import { Box, Text, Button } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import { getTraderPerformance, getTraderFeed } from '@/lib/data/trader'
import type { TraderPerformance, TraderFeedItem } from '@/lib/data/trader'

type Group = {
  id: string
  name: string
  subtitle?: string | null
}

export default function UserHomePage(props: { params: { handle: string } | Promise<{ handle: string }> }) {
  const resolvedParams = props.params && 'then' in props.params ? use(props.params as Promise<{ handle: string }>) : props.params
  const handle = resolvedParams?.handle ?? ''

  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<any>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [performance, setPerformance] = useState<TraderPerformance | null>(null)
  const [feed, setFeed] = useState<TraderFeedItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 获取当前用户
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    const load = async () => {
      if (!handle) return

      setLoading(true)

      try {
        // 获取用户资料
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('handle', handle)
          .maybeSingle()

        setProfile(profileData)

        if (!profileData) {
          setLoading(false)
          return
        }

        // 获取小组
        const { data: groupMemberships } = await supabase
          .from('group_members')
          .select('group_id, groups(id, name, subtitle)')
          .eq('user_id', profileData.id)

        if (groupMemberships) {
          setGroups(groupMemberships.map((gm: any) => gm.groups).filter(Boolean))
        }

        // 获取绩效和动态
        const [perfData, feedData] = await Promise.all([
          getTraderPerformance(handle),
          getTraderFeed(handle),
        ])

        setPerformance(perfData)
        setFeed(feedData)
      } catch (error) {
        console.error('Error loading user data:', error)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [handle])

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (!profile) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold">
            用户不存在
          </Text>
          <Link href="/" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[2], display: 'inline-block' }}>
            ← 返回首页
          </Link>
        </Box>
      </Box>
    )
  }

  const isOwnProfile = currentUserId === profile.id

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Profile Header */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            mb: 6,
            pb: 6,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            <Box
              style={{
                width: 80,
                height: 80,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                display: 'grid',
                placeItems: 'center',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize['2xl'],
                color: tokens.colors.text.primary,
                overflow: 'hidden',
              }}
            >
              {profile.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatar_url} alt={handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                (handle?.[0] ?? 'U').toUpperCase()
              )}
            </Box>

            <Box>
              <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
                {profile.handle || handle}
              </Text>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                ID: {profile.id}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[4] }}>
                <Text size="sm" color="secondary">
                  关注 <Text weight="bold" style={{ color: tokens.colors.text.primary }}>0</Text>
                </Text>
                <Text size="sm" color="secondary">
                  粉丝 <Text weight="bold" style={{ color: tokens.colors.text.primary }}>0</Text>
                </Text>
              </Box>
              {profile.bio && (
                <Text size="base" color="secondary" style={{ marginTop: tokens.spacing[3], lineHeight: 1.6 }}>
                  {profile.bio}
                </Text>
              )}
            </Box>
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            {isOwnProfile ? (
              <Button variant="ghost" size="md" onClick={() => alert('编辑个人资料')}>
                编辑个人资料
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="md" onClick={() => alert('关注')}>
                  关注
                </Button>
                <Button variant="primary" size="md" onClick={() => alert('私信')}>
                  私信
                </Button>
              </>
            )}
          </Box>
        </Box>

        {/* Main Content */}
        <UserHomeLayout
          userId={profile.id}
          handle={handle}
          avatarUrl={profile.avatar_url}
          bio={profile.bio}
          performance={performance || undefined}
          feed={feed}
          groups={groups}
          isOwnProfile={isOwnProfile}
        />
      </Box>
    </Box>
  )
}

