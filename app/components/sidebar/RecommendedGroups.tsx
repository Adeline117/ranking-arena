'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
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
  const initial = (name || '?').charAt(0).toUpperCase()
  if (avatarUrl) {
    return (
      <Image
        src={avatarUrl}
        alt={name}
        width={size}
        height={size}
        style={{
          borderRadius: tokens.radius.full,
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

export default function RecommendedGroups() {
  const { language, t } = useLanguage()
  const isZh = language === 'zh'
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [isPersonalized, setIsPersonalized] = useState(false)
  const auth = useUnifiedAuth()

  useEffect(() => {
    async function load() {
      try {
        // Try personalized recommendations if logged in
        if (auth.accessToken) {
          const res = await fetch('/api/recommendations/groups?limit=8', {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
          })
          if (res.ok) {
            const json = await res.json()
            if (json.success && json.data?.groups?.length > 0) {
              setGroups(json.data.groups as Group[])
              setIsPersonalized(json.data.personalized === true)
              setLoading(false)
              return
            }
          }
        }

        // Fallback: fetch by member_count
        const { data } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count')
          .order('member_count', { ascending: false })
          .limit(8)
        setGroups((data as Group[]) || [])
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [auth.accessToken])

  return (
    <SidebarCard title={t('sidebarRecommendedGroups')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 52, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('sidebarLoadFailedShort')}
        </div>
      ) : groups.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center' }}>
          <Image src="/stickers/confused.png" alt="No groups found" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
            {t('sidebarNoGroups')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {groups.map(g => {
            const displayName = isZh ? g.name : (g.name_en || g.name)
            const desc = isZh ? g.description : (g.description_en || g.description)
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
                    {(g.member_count || 0).toLocaleString()} {t('members')}
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
