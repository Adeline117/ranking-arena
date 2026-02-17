'use client'

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
  const initial = (name || '?').charAt(0).toUpperCase()
  if (avatarUrl) {
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

function formatRelativeTime(dateStr: string, isZh: boolean): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMin = Math.floor((now - then) / 60000)
  if (diffMin < 1) return isZh ? '刚刚' : 'just now'
  if (diffMin < 60) return isZh ? `${diffMin}分钟前` : `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return isZh ? `${diffH}小时前` : `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30) return isZh ? `${diffD}天前` : `${diffD}d ago`
  return isZh ? '很久以前' : 'long ago'
}

async function fetchMyGroups(userId: string): Promise<Group[]> {
  const { data } = await supabase
    .from('group_members')
    .select('group_id, groups(id, name, name_en, avatar_url, updated_at)')
    .eq('user_id', userId)
    .limit(10)

  return (data || []).map((d: any) => d.groups as Group).filter(Boolean)
}

export default function MyGroups() {
  const { language, t } = useLanguage()
  const isZh = language === 'zh'
  const { user } = useAuthSession()

  const { data: groups = [], isLoading } = useSWR(
    user ? ['my-groups', user.id] : null,
    ([, userId]) => fetchMyGroups(userId),
    {
      revalidateOnFocus: false,
      dedupingInterval: 300000,
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
      ) : groups.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.colors.text.secondary, textAlign: 'center', padding: '8px 0' }}>
          {t('sidebarNoGroupsJoined')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map(g => {
            const displayName = isZh ? g.name : (g.name_en || g.name)
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
                      {formatRelativeTime(g.updated_at, isZh)}
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
