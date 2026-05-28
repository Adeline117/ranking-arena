'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
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

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  description?: string | null
}

type SubTabKey = 'following' | 'recommended'

interface GroupsFeedPageProps {
  initialPosts?: unknown[]
  initialGroups?: unknown[]
}

export default function GroupsFeedPage({ initialPosts, initialGroups }: GroupsFeedPageProps) {
  const { language, t } = useLanguage()
  const { userId } = useAuthSession()
  const [myGroups, setMyGroups] = useState<Group[]>([])
  const [_loadingGroups, setLoadingGroups] = useState(true)
  const [_groupsError, setGroupsError] = useState(false)
  const [subTab, setSubTab] = useState<SubTabKey>('recommended')

  // Load user's joined groups
  useEffect(() => {
    if (!userId) {
      setLoadingGroups(false)
      return
    }

    const loadMyGroups = async () => {
      try {
        // Single joined query instead of 2 sequential queries (#36)
        const { data: memberships } = await supabase
          .from('group_members')
          .select('group_id, groups:group_id(id, name, name_en, avatar_url, member_count)')
          .eq('user_id', userId)

        if (!memberships || memberships.length === 0) {
          setMyGroups([])
          setLoadingGroups(false)
          return
        }

        const groupsData = memberships
          .map((m: Record<string, unknown>) => m.groups as Group | null)
          .filter((g): g is Group => g != null)
        setMyGroups(groupsData)
      } catch (err) {
        logger.error('Failed to load groups:', err)
        setGroupsError(true)
      } finally {
        setLoadingGroups(false)
      }
    }

    loadMyGroups()
  }, [userId])

  const myGroupIds = myGroups.map((g) => g.id)

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <h1 className="sr-only">{t('groups')}</h1>
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
          (myGroups.length > 0 ? (
            <PostFeed layout="masonry" groupIds={myGroupIds} />
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
                    background: tokens.colors.accent.primary,
                    color: '#000',
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
            {Array.isArray(initialGroups) && initialGroups.length > 0 && (
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                <Text
                  size="sm"
                  weight="bold"
                  color="secondary"
                  style={{ marginBottom: tokens.spacing[3] }}
                >
                  {t('groupsPopularTitle')}
                </Text>
                <Box
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                    gap: tokens.spacing[3],
                  }}
                >
                  {(initialGroups as Group[]).map((g) => {
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
                            src={
                              g.avatar_url.startsWith('data:')
                                ? g.avatar_url
                                : `/api/avatar?url=${encodeURIComponent(g.avatar_url)}`
                            }
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
                        background: tokens.colors.accent.primary,
                        color: '#000',
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
