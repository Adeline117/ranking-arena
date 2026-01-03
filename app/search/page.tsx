'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import Link from 'next/link'

type SearchResult = {
  type: 'trader' | 'post' | 'group'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

export default function SearchPage() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') || ''
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'all' | 'traders' | 'posts' | 'groups'>('all')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    const search = async () => {
      setLoading(true)
      const results: SearchResult[] = []

      try {
        // 搜索交易者
        const { data: traders } = await supabase
          .from('traders')
          .select('id, handle, roi, followers')
          .ilike('handle', `%${query}%`)
          .limit(10)

        if (traders) {
          traders.forEach((t: any) => {
            results.push({
              type: 'trader',
              id: t.id,
              title: t.handle,
              subtitle: `ROI: ${t.roi.toFixed(2)}%`,
              meta: `${t.followers} 粉丝`,
            })
          })
        }

        // 搜索帖子
        const { data: posts } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, created_at')
          .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
          .limit(10)

        if (posts) {
          posts.forEach((p: any) => {
            results.push({
              type: 'post',
              id: p.id,
              title: p.title,
              subtitle: p.content?.substring(0, 100),
              meta: `作者: ${p.author_handle || '未知'}`,
            })
          })
        }

        // 搜索小组
        const { data: groups } = await supabase
          .from('groups')
          .select('id, name, subtitle')
          .ilike('name', `%${query}%`)
          .limit(10)

        if (groups) {
          groups.forEach((g: any) => {
            results.push({
              type: 'group',
              id: g.id,
              title: g.name,
              subtitle: g.subtitle || '',
            })
          })
        }

        setResults(results)
      } catch (error) {
        console.error('Search error:', error)
      } finally {
        setLoading(false)
      }
    }

    const timeout = setTimeout(search, 300)
    return () => clearTimeout(timeout)
  }, [query])

  const filteredResults = activeTab === 'all' 
    ? results 
    : results.filter(r => {
        if (activeTab === 'traders') return r.type === 'trader'
        if (activeTab === 'groups') return r.type === 'group'
        if (activeTab === 'posts') return r.type === 'post'
        return false
      })

  const getHref = (result: SearchResult) => {
    if (result.type === 'trader') return `/trader/${result.id}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    return '#'
  }

  const getIcon = (type: string) => {
    if (type === 'trader') return '👤'
    if (type === 'post') return '📝'
    if (type === 'group') return '👥'
    return '🔍'
  }

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav email={email} />
      
      <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 950, marginBottom: '8px' }}>
            搜索结果
          </h1>
          <div style={{ fontSize: '14px', color: '#9a9a9a' }}>
            {query ? `搜索: "${query}"` : '请输入搜索关键词'}
          </div>
        </div>

        {query && (
          <div style={{ 
            display: 'flex', 
            gap: '8px', 
            marginBottom: '20px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            paddingBottom: '12px',
          }}>
            {(['all', 'traders', 'posts', 'groups'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  background: activeTab === tab ? '#8b6fa8' : 'rgba(255,255,255,0.05)',
                  color: activeTab === tab ? '#fff' : '#bdbdbd',
                  fontWeight: activeTab === tab ? 900 : 700,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                }}
              >
                {tab === 'all' ? '全部' : tab === 'traders' ? '交易者' : tab === 'posts' ? '帖子' : '小组'}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <RankingSkeleton />
        ) : !query ? (
          <EmptyState 
            icon="🔍"
            title="开始搜索"
            description="在顶部搜索栏输入关键词，搜索交易者、帖子或小组"
          />
        ) : filteredResults.length === 0 ? (
          <EmptyState 
            icon="🔍"
            title="未找到结果"
            description={`没有找到与"${query}"相关的内容`}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredResults.map((result) => (
              <Link
                key={`${result.type}-${result.id}`}
                href={getHref(result)}
                style={{
                  display: 'block',
                  padding: '16px',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: 'all 200ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
                  e.currentTarget.style.transform = 'translateX(4px)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                  e.currentTarget.style.transform = 'translateX(0)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ fontSize: '24px' }}>{getIcon(result.type)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '16px', fontWeight: 900, marginBottom: '4px', color: '#eaeaea' }}>
                      {result.title}
                    </div>
                    {result.subtitle && (
                      <div style={{ fontSize: '13px', color: '#9a9a9a', marginBottom: '4px' }}>
                        {result.subtitle}
                      </div>
                    )}
                    {result.meta && (
                      <div style={{ fontSize: '12px', color: '#777' }}>
                        {result.meta}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

