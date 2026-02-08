'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import SidebarCard from './SidebarCard'
import { useLanguage } from '../Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

interface ActiveUser {
  id: string
  handle: string
  avatar_url: string | null
  post_count: number
}

export default function ActiveUsersWidget() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [users, setUsers] = useState<ActiveUser[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        // Get users with most posts in last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const { data: posts } = await supabase
          .from('posts')
          .select('author_id')
          .gte('created_at', sevenDaysAgo)
          .not('author_id', 'is', null)

        if (!posts || posts.length === 0) { setLoading(false); return }

        // Count posts per author
        const counts = new Map<string, number>()
        for (const p of posts) {
          counts.set(p.author_id, (counts.get(p.author_id) || 0) + 1)
        }

        // Sort by count, take top 10
        const topIds = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)

        const ids = topIds.map(([id]) => id)
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', ids)

        if (profiles) {
          const profileMap = new Map(profiles.map(p => [p.id, p]))
          const result: ActiveUser[] = topIds
            .map(([id, count]) => {
              const p = profileMap.get(id)
              if (!p || !p.handle) return null
              return { id: p.id, handle: p.handle, avatar_url: p.avatar_url, post_count: count }
            })
            .filter(Boolean) as ActiveUser[]
          setUsers(result)
        }
      } catch (err) {
        console.error('Failed to load active users:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading || users.length === 0) return null

  return (
    <SidebarCard title={isZh ? '活跃用户' : 'Active Users'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {users.map(user => (
          <Link
            key={user.id}
            href={`/u/${encodeURIComponent(user.handle)}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 8px', borderRadius: 8,
              textDecoration: 'none', color: tokens.colors.text.primary,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
              background: user.avatar_url ? tokens.colors.bg.tertiary : getAvatarGradient(user.id),
              overflow: 'hidden', display: 'grid', placeItems: 'center',
            }}>
              {user.avatar_url ? (
                <Image
                  src={`/api/avatar?url=${encodeURIComponent(user.avatar_url)}`}
                  alt={user.handle}
                  width={28} height={28}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>
                  {getAvatarInitial(user.handle)}
                </span>
              )}
            </div>
            <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              @{user.handle}
            </span>
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, flexShrink: 0 }}>
              {user.post_count} {isZh ? '帖' : 'posts'}
            </span>
          </Link>
        ))}
      </div>
    </SidebarCard>
  )
}
