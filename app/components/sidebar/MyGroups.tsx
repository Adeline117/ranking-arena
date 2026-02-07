'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

type Group = {
  id: string
  name: string
  name_en: string | null
}

export default function MyGroups() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const { user } = useAuthSession()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) { setLoading(false); return }
    async function fetch() {
      const { data } = await supabase
        .from('group_members')
        .select('group_id, groups(id, name, name_en)')
        .eq('user_id', user!.id)
        .limit(10)
      const gs = (data || []).map((d: any) => d.groups).filter(Boolean)
      setGroups(gs)
      setLoading(false)
    }
    fetch()
  }, [user])

  if (!user) {
    return (
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8 }}>
          {isZh ? '我的小组' : 'My Groups'}
        </h3>
        <p style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
          {isZh ? '登录后查看' : 'Login to view'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        {isZh ? '我的小组' : 'My Groups'}
      </h3>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 28, borderRadius: 6 }} />)}
        </div>
      ) : groups.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
          {isZh ? '还没有加入小组' : 'No groups joined yet'}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map(g => (
            <Link
              key={g.id}
              href={`/groups/${g.id}`}
              style={{
                padding: '5px 4px', fontSize: 13, color: tokens.colors.text.primary,
                textDecoration: 'none', borderRadius: 6, transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.secondary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {isZh ? g.name : (g.name_en || g.name)}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
