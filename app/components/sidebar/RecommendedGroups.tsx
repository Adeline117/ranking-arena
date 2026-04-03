'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import useSWR from 'swr'
import { supabase } from '@/lib/supabase/client'
import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
import SidebarCard from './SidebarCard'

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

function GroupAvatar({ name, avatarUrl, size = 36 }: { name: string; avatarUrl: string | null; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const initial = (name || '?').charAt(0).toUpperCase()
  if (avatarUrl && !imgError) {
    return (
      <Image
        src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
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
        background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border))',
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

async function fetchRecommendedGroups(accessToken: string | null): Promise<{ groups: Group[]; personalized: boolean }> {
  if (accessToken) {
    try {
      const res = await fetch('/api/recommendations/groups?limit=8', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data?.groups?.length > 0) {
          return { groups: json.data.groups as Group[], personalized: json.data.personalized === true }
        }
      }
    } catch { /* fall through to default */ }
  }

  const { data } = await supabase
    .from('groups')
    .select('id, name, name_en, description, description_en, avatar_url, member_count')
    .order('member_count', { ascending: false })
    .limit(8)
  return { groups: (data as Group[]) || [], personalized: false }
}

export default function RecommendedGroups() {
  const { language, t } = useLanguage()
  const auth = useUnifiedAuth()

  const { data, error, isLoading: loading, mutate } = useSWR(
    ['recommended-groups', auth.accessToken],
    ([, token]) => fetchRecommendedGroups(token),
    {
      revalidateOnFocus: false,
      dedupingInterval: 300000,
      keepPreviousData: true,
      errorRetryCount: 3,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return
        setTimeout(() => revalidate({ retryCount }), 1000 * Math.pow(2, retryCount))
      },
    }
  )

  const groups = data?.groups || []
  const isPersonalized = data?.personalized || false

  return (
    <SidebarCard title={t('sidebarRecommendedGroups')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 52, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: `${tokens.spacing[3]} 0`, textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>
          <div>{t('sidebarLoadFailedShort')}</div>
          <button
            onClick={() => mutate()}
            style={{ marginTop: 6, padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.sm, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div style={{ padding: `${tokens.spacing[6]} ${tokens.spacing[3]}`, textAlign: 'center' }}>
          <Image src="/stickers/confused.webp" alt="No groups found" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
          <p style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
            {t('sidebarNoGroups')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {groups.map(g => {
            const displayName = localizedLabel(g.name, g.name_en, language)
            const desc = localizedLabel(g.description || '', g.description_en, language)
            return (
              <Link prefetch={false}
                key={g.id}
                href={`/groups/${g.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 6px',
                  textDecoration: 'none',
                  borderRadius: tokens.radius.md,
                  transition: `background ${tokens.transition.fast}`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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
                      <span style={{ marginLeft: 6, color: tokens.colors.text.secondary }}>
                        {desc.length > 20 ? desc.slice(0, 20) + '...' : desc}
                      </span>
                    )}
                    {isPersonalized && g.recommendation_reason && (
                      <span style={{ marginLeft: 6, color: tokens.colors.accent.primary, fontStyle: 'italic' }}>
                        {g.recommendation_reason}
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
