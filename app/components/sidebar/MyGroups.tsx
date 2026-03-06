'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import useSWR from 'swr'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import SidebarCard from './SidebarCard'

type Group = {
  id: string
  name: string
  name_en: string | null
  avatar_url: string | null
  updated_at: string | null
}

function GroupAvatar({ name, avatarUrl, size = 32 }: { name: string; avatarUrl: string | null; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const initial = (name || '?').charAt(0).toUpperCase()
  if (avatarUrl && !imgError) {
    return (
      <Image
        src={avatarUrl}
        alt={name}
        width={size}
        height={size}
        style={{
          borderRadius: tokens.radius.md,
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
        borderRadius: tokens.radius.md,
        background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.38,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: tokens.colors.text.primary,
      }}
    >
      {initial}
    </div>
  )
}

function formatRelativeTime(dateStr: string, t: (key: string) => string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMin = Math.floor((now - then) / 60000)
  if (diffMin < 1) return t('justNow')
  if (diffMin < 60) return t('minutesAgoShort').replace('{n}', String(diffMin))
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return t('hoursAgoShort').replace('{n}', String(diffH))
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30) return t('daysAgoShort').replace('{n}', String(diffD))
  return t('longAgo')
}

async function fetchMyGroups(userId: string): Promise<Group[]> {
  const { data } = await supabase
    .from('group_members')
    .select('group_id, groups(id, name, name_en, avatar_url, updated_at)')
    .eq('user_id', userId)
    .limit(10)

  return (data || [])
    .map((d: { groups: Group[] | null }) => d.groups?.[0] ?? null)
    .filter((group): group is Group => Boolean(group))
}

export default function MyGroups() {
  const { language, t } = useLanguage()
  const { user } = useAuthSession()

  const { data: groups = [], isLoading, error: swrError, mutate } = useSWR(
    user ? ['my-groups', user.id] : null,
    ([, userId]) => fetchMyGroups(userId),
    {
      revalidateOnFocus: false,
      dedupingInterval: 300000,
      errorRetryCount: 3,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return
        setTimeout(() => revalidate({ retryCount }), 1000 * Math.pow(2, retryCount))
      },
    }
  )

  const loading = !user ? false : isLoading

  return (
    <SidebarCard title={t('sidebarMyGroups')}>
      {!user ? (
        <p style={{ fontSize: 12, color: tokens.colors.text.secondary, textAlign: 'center', padding: '8px 0' }}>
          {t('sidebarLoginToView')}
        </p>
      ) : loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 40, borderRadius: tokens.radius.md }} />)}
        </div>
      ) : swrError ? (
        <div style={{ fontSize: 12, color: tokens.colors.text.secondary, textAlign: 'center', padding: '8px 0' }}>
          <div>{t('loadFailed')}</div>
          <button
            onClick={() => mutate()}
            style={{ marginTop: 6, padding: '4px 12px', borderRadius: 6, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: 12, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.colors.text.secondary, textAlign: 'center', padding: '8px 0' }}>
          {t('sidebarNoGroupsJoined')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map(g => {
            const displayName = language === 'zh' ? g.name : (g.name_en || g.name)
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
                <GroupAvatar name={displayName} avatarUrl={g.avatar_url} size={32} />
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
                  {g.updated_at && (
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: tokens.colors.text.tertiary,
                        marginTop: 1,
                      }}
                    >
                      {formatRelativeTime(g.updated_at, t)}
                    </div>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
