'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import PostFeed from '@/app/components/post/PostFeed'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generatePostArticleSchema, generateBreadcrumbSchema, combineSchemas } from '@/lib/seo'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import ShareButton from '@/app/components/common/ShareButton'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { trackInteraction } from '@/lib/tracking'
import { BASE_URL } from '@/lib/constants/urls'

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

export default function PostDetailClient({ postId }: { postId: string }) {
  const { email } = useAuthSession()
  const { language: _language, t } = useLanguage()
  const [postData, setPostData] = useState<PostData | null>(null)

  useEffect(() => {
    trackInteraction({ action: 'view', target_type: 'post', target_id: postId })
  }, [postId])

  useEffect(() => {
    Promise.resolve(
      supabase
        .from('posts')
        .select('id, title, content, author_handle, created_at, updated_at, like_count, comment_count, view_count')
        .eq('id', postId)
        .maybeSingle()
    ).then(({ data }) => {
      if (data) {
        setPostData(data as PostData)
      }
    }).catch(() => { /* Post fetch non-critical */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [postId])

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
      { name: t('home'), url: BASE_URL },
      { name: t('posts') },
      { name: postData.title.slice(0, 30) },
    ])
  ) : null

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary 
    }}>
      {structuredData && <JsonLd data={structuredData} />}
      <TopNav email={email} />
      <div style={{ 
        maxWidth: 800, 
        margin: '0 auto', 
        padding: tokens.spacing[6],
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Breadcrumb items={[
            { label: t('hotBreadcrumb'), href: '/hot' },
            { label: postData?.title?.slice(0, 30) || '...' },
          ]} />
          {postData && (
            <ShareButton
              data={{
                type: 'post',
                url: typeof window !== 'undefined' ? window.location.href : '',
                title: postData.title,
              }}
            />
          )}
        </div>
        <PostFeed initialPostId={postId} variant="full" />
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}
