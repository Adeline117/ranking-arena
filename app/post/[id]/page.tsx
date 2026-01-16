'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import PostFeed from '@/app/components/Features/PostFeed'
import { tokens } from '@/lib/design-tokens'

export default function PostDetailPage(props: { params: Promise<{ id: string }> }) {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [postId, setPostId] = useState<string | null>(null)

  // 解析 params
  useEffect(() => {
    props.params.then((resolved) => {
      setPostId(resolved.id)
    })
  }, [props.params])

  // 检查登录状态
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user?.email ?? null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setEmail(session?.user?.email ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (!postId) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: tokens.colors.bg.primary, 
        color: tokens.colors.text.primary 
      }}>
        <TopNav email={email} />
        <div style={{ 
          maxWidth: 800, 
          margin: '0 auto', 
          padding: tokens.spacing[6],
          textAlign: 'center',
        }}>
          加载中...
        </div>
      </div>
    )
  }

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary 
    }}>
      <TopNav email={email} />
      <div style={{ 
        maxWidth: 800, 
        margin: '0 auto', 
        padding: tokens.spacing[6],
      }}>
        {/* 返回按钮 */}
        <button
          onClick={() => router.back()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 0',
            marginBottom: 16,
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          ← 返回
        </button>
        
        {/* 帖子内容 - 使用 PostFeed 并设置 initialPostId 自动打开帖子详情 */}
        <PostFeed initialPostId={postId} variant="full" />
      </div>
    </div>
  )
}
