'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useQuery } from '@tanstack/react-query'
import { STALE_STATIC } from '@/lib/hooks/cache-presets'
import { supabase } from '@/lib/supabase/client'
import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import SidebarCard from './SidebarCard'
import { avatarSrc } from '@/lib/utils/avatar-proxy'

type Group = {
  id: string
  name: string
  name_en: string | null
  description: string | null
  description_en: string | null
  avatar_url: string | null
  member_count: number | null
  recommendation_reason?: string | null
}

// Map the server-emitted recommendation reason token (recommend_groups_for_user
// RPC + 'popular' padding) to a localized label. Falls back to the raw string for
// any unknown token so a new reason still shows something (U9-6: zh 态英文 "popular").
function reasonLabel(reason: string, t: (k: string) => string): string {
  switch (reason) {
    case 'popular':
      return t('u9grp_reasonPopular')
    case 'followed_users_joined':
      return t('u9grp_reasonFollowedJoined')
    case 'members_overlap':
      return t('u9grp_reasonMembersOverlap')
    default:
      return reason
  }
}

function GroupAvatar({
  name,
  avatarUrl,
  size = 36,
}: {
  name: string
  avatarUrl: string | null
  size?: number
}) {
  const [imgError, setImgError] = useState(false)
  const initial = (name || '?').charAt(0).toUpperCase()
  if (avatarUrl && !imgError) {
    return (
      <Image
        src={avatarSrc(avatarUrl)}
        alt={name}
        width={size}
        height={size}
        unoptimized
        style={{
          borderRadius: tokens.radius.full,
          objectFit: 'cover',
          minWidth: size,
        }}
        onError={() => setImgError(true)}
      />
    )
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: tokens.radius.full,
        background:
          'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: tokens.colors.text.primary,
      }}
    >
      {initial}
    </div>
  )
}

async function fetchRecommendedGroups(
  accessToken: string | null
): Promise<{ groups: Group[]; personalized: boolean }> {
  if (accessToken) {
    try {
      const res = await fetch('/api/recommendations/groups?limit=8', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data?.groups?.length > 0) {
          return {
            groups: json.data.groups as Group[],
            personalized: json.data.personalized === true,
          }
        }
      }
    } catch {
      /* fall through to default */
    }
  }

  const { data, error } = await supabase
    .from('groups')
    .select('id, name, name_en, description, description_en, avatar_url, member_count')
    .order('member_count', { ascending: false })
    .limit(8)
  if (error) throw new Error(error.message)

  return { groups: (data as Group[]) || [], personalized: false }
}

export default function RecommendedGroups() {
  const { language, t } = useLanguage()
  const auth = useAuthSession()

  const {
    data,
    error,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ['recommended-groups', auth.accessToken],
    queryFn: () => fetchRecommendedGroups(auth.accessToken),
    refetchOnWindowFocus: false,
    staleTime: STALE_STATIC,
    placeholderData: (prev) => prev,
    retry: 3,
    retryDelay: (attempt) => 1000 * Math.pow(2, attempt),
  })
  const mutate = () => refetch()

  const groups = data?.groups || []
  const isPersonalized = data?.personalized || false

  return (
    <SidebarCard title={t('sidebarRecommendedGroups')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="skeleton"
              style={{ height: 52, borderRadius: tokens.radius.md }}
            />
          ))}
        </div>
      ) : error ? (
        <div
          role="alert"
          style={{
            padding: `${tokens.spacing[3]} 0`,
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          <div>{t('sidebarLoadFailedShort')}</div>
          <button
            onClick={() => mutate()}
            style={{
              marginTop: tokens.spacing[1.5],
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              cursor: 'pointer',
            }}
          >
            {t('retry')}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div style={{ padding: `${tokens.spacing[6]} ${tokens.spacing[3]}`, textAlign: 'center' }}>
          <Image
            src="/stickers/confused.webp"
            alt="No groups found"
            width={48}
            height={48}
            style={{ margin: `0 auto ${tokens.spacing[2]}`, display: 'block', opacity: 0.7 }}
          />
          <p
            style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}
          >
            {t('sidebarNoGroups')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          {groups.map((g) => {
            const displayName = localizedLabel(g.name, g.name_en, language)
            const desc = localizedLabel(g.description || '', g.description_en, language)
            return (
              <Link
                prefetch={false}
                key={g.id}
                href={`/groups/${g.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2.5],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[1.5]}`,
                  textDecoration: 'none',
                  borderRadius: tokens.radius.md,
                }}
                className="hover-bg"
              >
                <GroupAvatar name={displayName} avatarUrl={g.avatar_url} size={36} />
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
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {(g.member_count || 0).toLocaleString('en-US')} {t('members')}
                    {!g.recommendation_reason && desc && (
                      <span
                        style={{
                          marginLeft: tokens.spacing[1.5],
                          color: tokens.colors.text.secondary,
                        }}
                      >
                        {desc.length > 20 ? desc.slice(0, 20) + '...' : desc}
                      </span>
                    )}
                    {isPersonalized && g.recommendation_reason && (
                      <span
                        style={{
                          marginLeft: tokens.spacing[1.5],
                          color: tokens.colors.accent.primary,
                          fontStyle: 'italic',
                        }}
                      >
                        {reasonLabel(g.recommendation_reason, t)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
