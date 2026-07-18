'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import { localizedLabel } from '@/lib/utils/format'
import { useLanguage } from '../Providers/LanguageProvider'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import RecommendedGroups from '@/app/components/sidebar/RecommendedGroups'
import NewsFlash from '@/app/components/sidebar/NewsFlash'
import PostFeed from '@/app/components/post/PostFeed'
import { Box, Text } from '@/app/components/base'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import ErrorState from '@/app/components/ui/ErrorState'

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  description?: string | null
  pinned?: boolean
}

type SubTabKey = 'following' | 'recommended'

interface GroupsFeedPageProps {
  initialPosts?: unknown[]
  initialGroups?: unknown[]
  initialGroupsStatus?: 'success' | 'error'
}

export default function GroupsFeedPage({
  initialPosts,
  initialGroups,
  initialGroupsStatus = 'success',
}: GroupsFeedPageProps) {
  const { language, t } = useLanguage()
  const { userId } = useAuthSession()
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [groupsError, setGroupsError] = useState(false)
  const [groupsLoadAttempt, setGroupsLoadAttempt] = useState(0)
  const [subTab, setSubTab] = useState<SubTabKey>('recommended')
  const [groupQuery, setGroupQuery] = useState('')
  const [recommendedGroups, setRecommendedGroups] = useState<Group[]>(
    Array.isArray(initialGroups) ? (initialGroups as Group[]) : []
  )
  const [recommendedGroupsError, setRecommendedGroupsError] = useState(
    initialGroupsStatus === 'error'
  )
  const [loadingRecommendedGroups, setLoadingRecommendedGroups] = useState(false)

  // Load user's joined groups
  useEffect(() => {
    let cancelled = false

    if (!userId) {
      setMyGroups([])
      setGroupsError(false)
      setLoadingGroups(false)
      return () => {
        cancelled = true
      }
    }

    const loadMyGroups = async () => {
      setMyGroups([])
      setGroupsError(false)
      setLoadingGroups(true)

      try {
        // Private membership preferences come from the caller-scoped projection;
        // the public directory intentionally does not expose pinned state.
        const { data: memberships, error: membershipsError } = await supabase
          .from('own_group_memberships')
          .select('group_id, pinned')
          .eq('user_id', userId)
        if (membershipsError) throw membershipsError

        if (!memberships || memberships.length === 0) {
          if (!cancelled) setMyGroups([])
          return
        }

        const groupIds = memberships.map((membership) => membership.group_id)
        const { data: joinedGroups, error: joinedGroupsError } = await supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .in('id', groupIds)
        if (joinedGroupsError) throw joinedGroupsError

        const groupById = new Map((joinedGroups || []).map((group) => [group.id, group]))

        const groupsData = memberships
          .map((membership) => {
            const group = groupById.get(membership.group_id)
            return group ? ({ ...group, pinned: !!membership.pinned } as Group) : null
          })
          .filter((g): g is Group => g != null)
          // pinned first, then keep insertion order (recency of membership)
          .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
        if (!cancelled) setMyGroups(groupsData)
      } catch (err) {
        logger.error('Failed to load groups:', err)
        if (!cancelled) {
          setMyGroups([])
          setGroupsError(true)
        }
      } finally {
        if (!cancelled) setLoadingGroups(false)
      }
    }

    void loadMyGroups()

    return () => {
      cancelled = true
    }
  }, [groupsLoadAttempt, userId])

  const myGroupIds = myGroups.map((g) => g.id)
  const showRecommendedGroups =
    !loadingRecommendedGroups && !recommendedGroupsError && recommendedGroups.length > 0

  const retryRecommendedGroups = async () => {
    setLoadingRecommendedGroups(true)
    setRecommendedGroupsError(false)

    try {
      const { data, error } = await supabase
        .from('groups')
        .select('id, name, name_en, avatar_url, member_count, description')
        .order('member_count', { ascending: false })
        .limit(8)
      if (error) throw error

      setRecommendedGroups((data as Group[]) || [])
    } catch (err) {
      logger.error('Failed to retry recommended groups:', err)
      setRecommendedGroups([])
      setRecommendedGroupsError(true)
    } finally {
      setLoadingRecommendedGroups(false)
    }
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: `0 ${tokens.spacing[4]}` }}>
        <PageHeader
          title={t('groups')}
          compact
          actions={
            <Link
              href="/groups/apply"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                background: 'var(--color-brand-deep)',
                color: 'var(--color-on-accent)',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                textDecoration: 'none',
              }}
            >
              + {t('createGroup')}
            </Link>
          }
        />
      </Box>
      <ThreeColumnLayout
        leftSidebar={
          <Suspense
            fallback={
              <div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />
            }
          >
            <RecommendedGroups />
          </Suspense>
        }
        rightSidebar={
          <Suspense
            fallback={
              <div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />
            }
          >
            <NewsFlash />
          </Suspense>
        }
      >
        {/* Tabs: 关注 / 推荐 / 书架 */}
        <Box
          role="tablist"
          style={{
            display: 'flex',
            gap: tokens.spacing[5],
            marginBottom: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            paddingBottom: 0,
          }}
        >
          {[
            { key: 'following' as SubTabKey, label: t('following') },
            { key: 'recommended' as SubTabKey, label: t('recommended') },
          ].map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={subTab === tab.key}
              onClick={() => setSubTab(tab.key)}
              style={{
                padding: `${tokens.spacing[2]} 0 ${tokens.spacing[2]}`,
                minHeight: tokens.touchTarget.min,
                border: 'none',
                background: 'transparent',
                color:
                  subTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                fontWeight: subTab === tab.key ? 700 : 500,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                borderBottom:
                  subTab === tab.key
                    ? `2.5px solid ${tokens.colors.accent.primary}`
                    : '2.5px solid transparent',
                transition: `all ${tokens.transition.base}`,
                marginBottom: '-1px',
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {subTab === 'following' &&
          (loadingGroups ? (
            <Box
              aria-busy="true"
              style={{
                padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <div className="skeleton" style={{ height: 80, borderRadius: tokens.radius.lg }} />
            </Box>
          ) : groupsError ? (
            <ErrorState
              variant="compact"
              title={t('sidebarLoadFailedShort')}
              description={t('loadFailedRetryShort')}
              retry={() => setGroupsLoadAttempt((attempt) => attempt + 1)}
            />
          ) : myGroups.length > 0 ? (
            <>
              {/* My-groups rail — pinned groups first, marked with 📌 (U9-12) */}
              <Box
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: tokens.spacing[2],
                  marginBottom: tokens.spacing[4],
                }}
              >
                {myGroups.map((g) => (
                  <Link
                    key={g.id}
                    href={`/groups/${g.id}`}
                    prefetch={false}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: `${tokens.spacing[1.5]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.full,
                      background: g.pinned
                        ? 'var(--color-accent-primary-10)'
                        : tokens.colors.bg.secondary,
                      border: `1px solid ${g.pinned ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.medium,
                      textDecoration: 'none',
                      transition: `border-color ${tokens.transition.fast}`,
                    }}
                  >
                    {g.pinned && (
                      <span
                        aria-label={t('groupPrefs_pinnedBadge')}
                        title={t('groupPrefs_pinnedBadge')}
                      >
                        📌
                      </span>
                    )}
                    {localizedLabel(g.name, g.name_en, language)}
                  </Link>
                ))}
              </Box>
              <PostFeed layout="masonry" groupIds={myGroupIds} />
            </>
          ) : (
            <Box
              style={{
                padding: `${tokens.spacing[12]} ${tokens.spacing[6]}`,
                textAlign: 'center',
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <svg
                width={48}
                height={48}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.5, marginBottom: 16, color: tokens.colors.accent.primary }}
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <Text
                size="sm"
                weight="bold"
                color="secondary"
                style={{ marginBottom: tokens.spacing[2] }}
              >
                {t('noGroupsFollowedYet')}
              </Text>
              <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
                {userId ? t('joinGroupsToSeePosts') : t('groupsLoginCta')}
              </Text>
              {!userId && (
                <Link
                  href="/login?returnUrl=/groups"
                  style={{
                    display: 'inline-block',
                    marginTop: tokens.spacing[4],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
                    borderRadius: tokens.radius.md,
                    background: 'var(--color-brand-deep)',
                    color: tokens.colors.white,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    textDecoration: 'none',
                    transition: `opacity ${tokens.transition.fast}`,
                  }}
                >
                  {t('login')}
                </Link>
              )}
            </Box>
          ))}

        {subTab === 'recommended' && (
          <>
            {/* Show popular groups grid for all users, especially useful for unauthenticated visitors */}
            {loadingRecommendedGroups && (
              <Box
                aria-busy="true"
                style={{
                  padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
                  marginBottom: tokens.spacing[5],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.xl,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <div className="skeleton" style={{ height: 120, borderRadius: tokens.radius.lg }} />
              </Box>
            )}
            {!loadingRecommendedGroups && recommendedGroupsError && (
              <ErrorState
                variant="compact"
                title={t('sidebarLoadFailedShort')}
                description={t('loadFailedRetryShort')}
                retry={() => void retryRecommendedGroups()}
              />
            )}
            {showRecommendedGroups && (
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                <Text
                  size="sm"
                  weight="bold"
                  color="secondary"
                  style={{ marginBottom: tokens.spacing[3] }}
                >
                  {t('groupsPopularTitle')}
                </Text>
                {/* Group-name search — the top navbar search only covers traders,
                    so groups had no discovery control (U9-7). Filters the loaded list. */}
                <input
                  type="text"
                  value={groupQuery}
                  onChange={(e) => setGroupQuery(e.target.value)}
                  placeholder={t('u9grp_searchPlaceholder')}
                  aria-label={t('u9grp_searchPlaceholder')}
                  style={{
                    width: '100%',
                    marginBottom: tokens.spacing[3],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    outline: 'none',
                  }}
                />
                {(() => {
                  const q = groupQuery.trim().toLowerCase()
                  const filteredGroups = q
                    ? recommendedGroups.filter((g) =>
                        [g.name, g.name_en]
                          .filter(Boolean)
                          .some((n) => (n as string).toLowerCase().includes(q))
                      )
                    : recommendedGroups
                  if (filteredGroups.length === 0) {
                    return (
                      <Text
                        size="sm"
                        color="tertiary"
                        style={{ padding: `${tokens.spacing[3]} 0` }}
                      >
                        {t('u9grp_noSearchResults')}
                      </Text>
                    )
                  }
                  return (
                    <Box
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: tokens.spacing[3],
                      }}
                    >
                      {filteredGroups.map((g) => {
                        const displayName = localizedLabel(g.name, g.name_en, language)
                        return (
                          <Link
                            key={g.id}
                            href={`/groups/${g.id}`}
                            prefetch={false}
                            className="card-hover"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: tokens.spacing[3],
                              padding: tokens.spacing[4],
                              background: tokens.colors.bg.secondary,
                              borderRadius: tokens.radius.lg,
                              border: `1px solid ${tokens.colors.border.primary}`,
                              textDecoration: 'none',
                              transition: `border-color ${tokens.transition.fast}`,
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.borderColor = tokens.colors.accent.primary)
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.borderColor = tokens.colors.border.primary)
                            }
                          >
                            {g.avatar_url ? (
                              <Image
                                src={avatarSrc(g.avatar_url)}
                                alt={displayName}
                                width={40}
                                height={40}
                                unoptimized
                                style={{
                                  borderRadius: tokens.radius.full,
                                  objectFit: 'cover',
                                  minWidth: 40,
                                }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: 40,
                                  height: 40,
                                  minWidth: 40,
                                  borderRadius: tokens.radius.full,
                                  background:
                                    'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border))',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: 16,
                                  fontWeight: tokens.typography.fontWeight.semibold,
                                  color: tokens.colors.text.primary,
                                }}
                              >
                                {(displayName || '?').charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: tokens.typography.fontSize.sm,
                                  fontWeight: tokens.typography.fontWeight.medium,
                                  color: tokens.colors.text.primary,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {displayName}
                              </div>
                              <div
                                style={{
                                  fontSize: tokens.typography.fontSize.xs,
                                  color: tokens.colors.text.tertiary,
                                  marginTop: 1,
                                }}
                              >
                                {(g.member_count || 0).toLocaleString('en-US')} {t('members')}
                              </div>
                            </div>
                          </Link>
                        )
                      })}
                    </Box>
                  )
                })()}
                {!userId && (
                  <Box style={{ textAlign: 'center', marginTop: tokens.spacing[4] }}>
                    <Text size="xs" color="tertiary">
                      {t('groupsLoginCta')}
                    </Text>
                    <Link
                      href="/login?returnUrl=/groups"
                      style={{
                        display: 'inline-block',
                        marginTop: tokens.spacing[2],
                        padding: `${tokens.spacing[1.5]} ${tokens.spacing[5]}`,
                        borderRadius: tokens.radius.md,
                        background: 'var(--color-brand-deep)',
                        color: tokens.colors.white,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: tokens.typography.fontWeight.semibold,
                        textDecoration: 'none',
                        transition: `opacity ${tokens.transition.fast}`,
                      }}
                    >
                      {t('login')}
                    </Link>
                  </Box>
                )}
              </Box>
            )}
            <PostFeed layout="masonry" initialPosts={initialPosts} />
          </>
        )}
      </ThreeColumnLayout>

      <FloatingActionButton />
    </Box>
  )
}
