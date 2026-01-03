'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import Card from '@/app/components/UI/Card'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import { LikeIcon, CommentIcon } from '@/app/components/Icons'

type Group = {
  id: string
  name: string
  subtitle?: string | null
}

type Post = {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
}

export default function GroupDetailPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
  const [groupId, setGroupId] = useState<string>('')
  
  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ id: string }>).then(resolved => {
        setGroupId(resolved.id)
      })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])
  
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  useEffect(() => {
    if (groupId === 'loading') return

    const load = async () => {
      setLoading(true)
      setError(null)

      try {
        // 读取小组信息
        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .select('id, name, subtitle')
          .eq('id', groupId)
          .maybeSingle()

        if (groupErr) {
          setError(groupErr.message)
          setLoading(false)
          return
        }

        setGroup(groupData as Group | null)

        // 读取帖子
        const { data: postsData, error: postsErr } = await supabase
          .from('posts')
          .select('id, group_id, title, content, created_at, author_handle, like_count, comment_count')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false })
          .limit(50)

        if (postsErr) {
          setError(postsErr.message)
        } else {
          setPosts((postsData || []) as Post[])
        }
      } catch (err: any) {
        setError(err?.message || '加载失败')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [groupId])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={email} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
          <div style={{ color: '#9a9a9a', textAlign: 'center' }}>{t('loading')}</div>
        </main>
      </div>
    )
  }

  if (error || !group) {
    return (
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={email} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
          <div style={{ color: '#ff7c7c' }}>错误: {error || '小组不存在'}</div>
          <Link href="/groups" style={{ color: '#8b6fa8', textDecoration: 'none', marginTop: '12px', display: 'inline-block' }}>
            ← 返回小组列表
          </Link>
        </main>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav email={email} />

      <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: 950, marginBottom: '8px' }}>{group.name}</h1>
            {group.subtitle && (
              <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>{group.subtitle}</div>
            )}
          </div>

          <Link 
            href="/groups" 
            style={{ 
              color: '#8b6fa8', 
              textDecoration: 'none',
              fontSize: '14px',
              fontWeight: 700,
            }}
          >
            ← 返回小组
          </Link>
        </div>

        {/* New Post Button */}
        <div style={{ marginBottom: '24px' }}>
          <Link
            href={`/groups/${groupId}/new`}
            style={{
              display: 'inline-block',
              padding: '12px 20px',
              background: '#8b6fa8',
              color: '#fff',
              borderRadius: '12px',
              textDecoration: 'none',
              fontWeight: 900,
              fontSize: '14px',
              transition: 'all 200ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#a085b8'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#8b6fa8'
              e.currentTarget.style.transform = 'translateY(0)'
            }}
          >
            + 发新帖
          </Link>
        </div>

        {/* Posts */}
        <Card title={`帖子 (${posts.length})`}>
          {posts.length === 0 ? (
            <div style={{ 
              color: 'rgba(255,255,255,0.6)', 
              padding: '40px 20px',
              textAlign: 'center',
              fontSize: '14px',
            }}>
              还没有帖子，成为第一个发帖的人吧！
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {posts.map((post) => (
                <div
                  key={post.id}
                  style={{
                    padding: '16px',
                    borderRadius: '12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    transition: 'all 200ms ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                    <div style={{ fontSize: '16px', fontWeight: 900 }}>{post.title}</div>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                      {new Date(post.created_at).toLocaleString('zh-CN')}
                    </div>
                  </div>

                  {post.author_handle && (
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px' }}>
                      作者: <Link href={`/user/${post.author_handle}`} style={{ color: '#8b6fa8', textDecoration: 'none' }}>@{post.author_handle}</Link>
                    </div>
                  )}

                  {post.content && (
                    <div style={{ 
                      marginTop: '12px', 
                      fontSize: '14px', 
                      color: 'rgba(255,255,255,0.8)', 
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                    }}>
                      {post.content}
                    </div>
                  )}

                  <div style={{ 
                    marginTop: '12px', 
                    display: 'flex', 
                    gap: '16px',
                    paddingTop: '12px',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    <button
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'rgba(255,255,255,0.7)',
                        fontSize: '13px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => alert('Like (mock)')}
                    >
                      <LikeIcon size={14} />
                      <span>{post.like_count || 0}</span>
                    </button>
                    <button
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'rgba(255,255,255,0.7)',
                        fontSize: '13px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => alert('Comment (mock)')}
                    >
                      <CommentIcon size={14} />
                      <span>{post.comment_count || 0}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </main>
    </div>
  )
}
