'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type Group = {
  id: string
  name: string
  name_en: string | null
  member_count: number | null
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
          .select('id, name, name_en, member_count')
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
            <div key={i} className="skeleton" style={{ height: 32, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '加载失败' : 'Failed to load'}
        </div>
      ) : groups.length === 0 ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '暂无小组' : 'No groups available'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map(g => (
            <Link
              key={g.id}
              href={`/groups/${g.id}`}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 4px', textDecoration: 'none', borderRadius: tokens.radius.md,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontSize: 13, color: tokens.colors.text.primary }}>
                {isZh ? g.name : (g.name_en || g.name)}
              </span>
              <span style={{ fontSize: 11, color: tokens.colors.text.secondary }}>
                {(g.member_count || 0).toLocaleString()} {isZh ? '成员' : 'members'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </SidebarCard>
  )
}
