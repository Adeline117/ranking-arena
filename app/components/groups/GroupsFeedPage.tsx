'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
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
import { Box, Text, Button } from '@/app/components/base'
import { Skeleton } from '@/app/components/ui/Skeleton'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

type TabKey = 'feed' | 'discover'
type SubTabKey = 'following' | 'recommended' | 'bookshelf'

export default function GroupsFeedPage() {
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [loadingDiscover, setLoadingDiscover] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('feed')
  const [subTab, setSubTab] = useState<SubTabKey>('recommended')

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

  // Load all groups for discover tab
  useEffect(() => {
    if (activeTab !== 'discover') return

    const loadAll = async () => {
      setLoadingDiscover(true)
      try {
        const query = supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(30)

        const { data } = await query
        setAllGroups(data || [])
      } catch (err) {
        console.error('Failed to load groups:', err)
      } finally {
        setLoadingDiscover(false)
      }
    }

    loadAll()
  }, [activeTab])

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
        {/* Header with tabs and create button */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[3],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            paddingBottom: tokens.spacing[2],
          }}
        >
          <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
          {([
            { key: 'feed' as TabKey, label: t('groupFeed') },
            { key: 'discover' as TabKey, label: t('discoverGroups') },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: activeTab === tab.key ? tokens.gradient.primary : 'transparent',
                color: activeTab === tab.key ? '#fff' : tokens.colors.text.secondary,
                fontWeight: activeTab === tab.key ? 800 : 600,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                  e.currentTarget.style.color = tokens.colors.text.primary
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }
              }}
            >
              {tab.label}
            </button>
          ))}
          </Box>
          <Link
            href="/groups/apply"
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.gradient.primary,
              color: '#fff',
              fontWeight: 800,
              fontSize: tokens.typography.fontSize.sm,
              textDecoration: 'none',
              transition: `all ${tokens.transition.base}`,
              whiteSpace: 'nowrap',
            }}
          >
            + {t('createGroup')}
          </Link>
        </Box>

        {/* Sub-tabs: 关注 / 推荐 / 书架 */}
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

        {activeTab === 'feed' ? (
          <>
            {/* My Groups - Horizontal scrollable */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2], textTransform: 'uppercase' }}>
                {t('myGroups')}
              </Text>

              {loadingGroups ? (
                <Box style={{ display: 'flex', gap: tokens.spacing[3], overflowX: 'hidden', paddingBottom: tokens.spacing[2] }}>
                  {[0, 1, 2, 3].map((i) => (
                    <Box key={i} style={{ flexShrink: 0, width: 120, padding: tokens.spacing[3], borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.secondary, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[2] }}>
                      <Skeleton width="40px" height="40px" variant="rounded" />
                      <Skeleton width="80px" height="12px" />
                      <Skeleton width="50px" height="10px" />
                    </Box>
                  ))}
                </Box>
              ) : myGroups.length === 0 ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center', background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
                  <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                    {t('noGroupsJoined')}
                  </Text>
                  <Button variant="primary" size="sm" onClick={() => setActiveTab('discover')}>
                    {t('discoverGroupsAction')}
                  </Button>
                </Box>
              ) : (
                <Box style={{ display: 'flex', gap: tokens.spacing[3], overflowX: 'auto', paddingBottom: tokens.spacing[2], scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}>
                  {myGroups.map((group) => (
                    <Link
                      key={group.id}
                      href={`/groups/${group.id}`}
                      style={{
                        flexShrink: 0, width: 120, padding: tokens.spacing[3], borderRadius: tokens.radius.lg,
                        border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.secondary,
                        textDecoration: 'none', color: tokens.colors.text.primary,
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[2],
                        scrollSnapAlign: 'start', transition: `all ${tokens.transition.base}`,
                      }}
                    >
                      <Box style={{ width: 40, height: 40, borderRadius: tokens.radius.lg, background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))', border: `1px solid ${tokens.colors.border.primary}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                        {group.avatar_url ? (
                          <Image src={group.avatar_url} alt={group.name} width={40} height={40} style={{ width: '100%', height: '100%', objectFit: 'cover' }} unoptimized onError={(e) => { e.currentTarget.style.display = 'none' }} />
                        ) : (
                          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.brandLight }}>
                            {group.name.charAt(0).toUpperCase()}
                          </Text>
                        )}
                      </Box>
                      <Text size="xs" weight="bold" style={{ textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
                        {language === 'zh' ? group.name : (group.name_en || group.name)}
                      </Text>
                      {group.member_count != null && (
                        <Text size="xs" color="tertiary">
                          {group.member_count} {t('members')}
                        </Text>
                      )}
                    </Link>
                  ))}
                </Box>
              )}
            </Box>

            {/* Group feed - posts from joined groups */}
            {myGroups.length > 0 ? (
              <PostFeed
                layout="list"
                groupIds={myGroupIds}
              />
            ) : (
              <Box style={{ padding: tokens.spacing[6], textAlign: 'center', background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
                <Text size="sm" color="tertiary">
                  {t('joinGroupsToSeePosts')}
                </Text>
              </Box>
            )}
          </>
        ) : (
          /* Discover tab */
          <Box>
            {/* Groups grid */}
            {loadingDiscover ? (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], padding: tokens.spacing[3], borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.secondary }}>
                    <Skeleton width="44px" height="44px" variant="rounded" />
                    <Box style={{ flex: 1 }}>
                      <Box style={{ marginBottom: 6 }}>
                        <Skeleton width="60%" height="14px" />
                      </Box>
                      <Skeleton width="40%" height="12px" />
                    </Box>
                  </Box>
                ))}
              </Box>
            ) : allGroups.length === 0 ? (
              <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
                <Text size="sm" color="tertiary">
                  {t('noGroupsFound')}
                </Text>
              </Box>
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {allGroups.map((group) => {
                  const isJoined = myGroupIds.includes(group.id)
                  return (
                    <Link
                      key={group.id}
                      href={`/groups/${group.id}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                        padding: tokens.spacing[3], borderRadius: tokens.radius.lg,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: tokens.colors.bg.secondary,
                        textDecoration: 'none', color: tokens.colors.text.primary,
                        transition: `all ${tokens.transition.base}`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = `${tokens.colors.accent?.primary || tokens.colors.accent.brand}50`
                        e.currentTarget.style.transform = 'translateX(4px)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                        e.currentTarget.style.transform = 'translateX(0)'
                      }}
                    >
                      <Box style={{ width: 44, height: 44, borderRadius: tokens.radius.lg, background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))', border: `1px solid ${tokens.colors.border.primary}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
                        {group.avatar_url ? (
                          <Image src={group.avatar_url} alt={group.name} fill style={{ objectFit: 'cover' }} unoptimized onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        ) : (
                          <Text size="base" weight="bold" style={{ color: tokens.colors.accent.brandLight }}>
                            {group.name.charAt(0).toUpperCase()}
                          </Text>
                        )}
                      </Box>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {language === 'zh' ? group.name : (group.name_en || group.name)}
                        </Text>
                        <Text size="xs" color="tertiary">
                          {group.member_count || 0} {t('members')}
                        </Text>
                      </Box>
                      {isJoined && (
                        <Text size="xs" color="tertiary" style={{ flexShrink: 0, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary }}>
                          {t('joined')}
                        </Text>
                      )}
                    </Link>
                  )
                })}
              </Box>
            )}
          </Box>
        )}
      </ThreeColumnLayout>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
