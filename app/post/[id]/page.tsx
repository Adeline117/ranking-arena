'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import PostFeed from '@/app/components/post/PostFeed'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generatePostArticleSchema, generateBreadcrumbSchema, combineSchemas } from '@/lib/seo'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

interface PostData {
  id: string
  title: string
  content: string
  author_handle: string
  created_at: string
  updated_at?: string
  like_count?: number
  comment_count?: number
  view_count?: number
}

export default function PostDetailPage(props: { params: Promise<{ id: string }> }) {
  const router = useRouter()
  const { email } = useAuthSession()
  const { language } = useLanguage()
  const [postId, setPostId] = useState<string | null>(null)
  const [postData, setPostData] = useState<PostData | null>(null)

  // 解析 params
  useEffect(() => {
    props.params.then((resolved) => {
      setPostId(resolved.id)
    })
  }, [props.params])

  // 获取帖子数据用于 SEO
  useEffect(() => {
    if (!postId) return

    supabase
      .from('posts')
      .select('id, title, content, author_handle, created_at, updated_at, like_count, comment_count, view_count')
      .eq('id', postId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setPostData(data as PostData)
        }
      })
  }, [postId])

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
          {language === 'zh' ? '加载中...' : 'Loading...'}
        </div>
      </div>
    )
  }

  // 生成结构化数据
  const structuredData = postData ? combineSchemas(
    generatePostArticleSchema({
      id: postData.id,
      title: postData.title,
      content: postData.content,
      authorHandle: postData.author_handle,
      createdAt: postData.created_at,
      updatedAt: postData.updated_at,
      likeCount: postData.like_count,
      commentCount: postData.comment_count,
      viewCount: postData.view_count,
    }),
    generateBreadcrumbSchema([
      { name: '首页', url: process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org' },
      { name: '帖子' },
      { name: postData.title.slice(0, 30) },
    ])
  ) : null

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary 
    }}>
      {/* JSON-LD 结构化数据 */}
      {structuredData && <JsonLd data={structuredData} />}
      
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
