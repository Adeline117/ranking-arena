'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import TopNav from '@/app/components/layout/TopNav'
import DesktopSidebar from '@/app/components/layout/DesktopSidebar'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
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

export default function GroupsFeedPage() {
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [loadingDiscover, setLoadingDiscover] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('feed')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce search input (300ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery])

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
        let query = supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(30)

        if (debouncedQuery.trim()) {
          const sanitized = debouncedQuery.trim()
            .slice(0, 100)
            .replace(/[\\%_]/g, c => `\\${c}`)
          query = query.or(`name.ilike.%${sanitized}%,name_en.ilike.%${sanitized}%`)
        }

        const { data } = await query
        setAllGroups(data || [])
      } catch (err) {
        console.error('Failed to load groups:', err)
      } finally {
        setLoadingDiscover(false)
      }
    }

    loadAll()
  }, [activeTab, debouncedQuery])

  const myGroupIds = myGroups.map(g => g.id)

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
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          paddingBottom: 100,
        }}
      >
        {/* Tabs */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            marginBottom: tokens.spacing[3],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            paddingBottom: tokens.spacing[2],
          }}
        >
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
                          <Text size="sm" weight="bold" style={{ color: '#c9b8db' }}>
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
            {/* Search */}
            <Box style={{ marginBottom: tokens.spacing[3] }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('searchGroupsPlaceholder')}
                style={{
                  width: '100%',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>

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
                          <Text size="base" weight="bold" style={{ color: '#c9b8db' }}>
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
      </Box>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
