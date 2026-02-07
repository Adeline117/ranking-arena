'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('groups')
        .select('id, name, name_en, member_count')
        .order('member_count', { ascending: false })
        .limit(8)
      setGroups((data as Group[]) || [])
      setLoading(false)
    }
    fetch()
  }, [])

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        📋 {isZh ? '推荐小组' : 'Recommended Groups'}
      </h3>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 32, borderRadius: 6 }} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map(g => (
            <Link
              key={g.id}
              href={`/groups/${g.id}`}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 4px', textDecoration: 'none', borderRadius: 6,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.secondary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontSize: 13, color: tokens.colors.text.primary }}>
                {isZh ? g.name : (g.name_en || g.name)}
              </span>
              <span style={{ fontSize: 11, color: tokens.colors.text.secondary }}>
                {g.member_count || 0} 👥
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
