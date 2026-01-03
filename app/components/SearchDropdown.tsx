'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import Link from 'next/link'

type SearchDropdownProps = {
  open: boolean
  query: string
  onClose: () => void
}

export default function SearchDropdown({ open, query, onClose }: SearchDropdownProps) {
  const [history, setHistory] = useState<string[]>([])
  const [hotPosts, setHotPosts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return

    // 加载搜索历史
    const saved = localStorage.getItem('searchHistory')
    if (saved) {
      try {
        setHistory(JSON.parse(saved).slice(0, 5))
      } catch {
        setHistory([])
      }
    }

    // 加载热榜帖子
    const loadHotPosts = async () => {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('posts')
          .select('id, title, like_count, comment_count')
          .order('like_count', { ascending: false })
          .limit(10)

        setHotPosts(data || [])
      } catch (error) {
        console.error('Load hot posts error:', error)
      } finally {
        setLoading(false)
      }
    }

    loadHotPosts()
  }, [open])

  const addToHistory = (term: string) => {
    if (!term.trim()) return
    const newHistory = [term, ...history.filter(h => h !== term)].slice(0, 5)
    setHistory(newHistory)
    localStorage.setItem('searchHistory', JSON.stringify(newHistory))
  }

  const clearHistory = () => {
    setHistory([])
    localStorage.removeItem('searchHistory')
  }

  if (!open) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: 0,
        right: 0,
        background: '#0b0b0b',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '12px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        zIndex: 300,
        maxHeight: '500px',
        overflow: 'auto',
      }}
    >
      {/* 搜索历史 */}
      {history.length > 0 && (
        <div style={{ padding: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>搜索历史</div>
            <button
              onClick={clearHistory}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#8b6fa8',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '4px 8px',
              }}
            >
              清空
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {history.map((term, idx) => (
              <Link
                key={idx}
                href={`/search?q=${encodeURIComponent(term)}`}
                onClick={() => addToHistory(term)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  color: 'rgba(255,255,255,0.8)',
                  textDecoration: 'none',
                  fontSize: '13px',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {term}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 热榜帖子 */}
      <div style={{ padding: '12px', borderTop: history.length > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
          热榜前十
        </div>
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px', padding: '8px' }}>加载中...</div>
        ) : hotPosts.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px', padding: '8px' }}>暂无热帖</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {hotPosts.map((post, idx) => (
              <Link
                key={post.id}
                href={`/post/${post.id}`}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  color: 'rgba(255,255,255,0.8)',
                  textDecoration: 'none',
                  fontSize: '13px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {idx + 1}. {post.title}
                </span>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginLeft: '8px' }}>
                  {(post.like_count || 0) + (post.comment_count || 0)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

