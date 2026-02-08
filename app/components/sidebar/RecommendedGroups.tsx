'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type Group = {
  id: string
  name: string
  name_en: string | null
  description: string | null
  description_en: string | null
  avatar_url: string | null
  member_count: number | null
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
        background: 'linear-gradient(135deg, rgba(139,111,168,0.3), rgba(212,168,67,0.3))',
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
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      try {
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
  }, [])

  return (
    <SidebarCard title={isZh ? '推荐小组' : 'Recommended Groups'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 52, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '加载失败' : 'Failed to load'}
        </div>
      ) : groups.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center' }}>
          <img src="/stickers/confused.png" alt="" width={48} height={48} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
            {isZh ? '暂无小组' : 'No groups available'}
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
                    {(g.member_count || 0).toLocaleString()} {isZh ? '成员' : 'members'}
                    {desc && (
                      <span style={{ marginLeft: 6, color: tokens.colors.text.secondary }}>
                        {desc.length > 20 ? desc.slice(0, 20) + '...' : desc}
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
