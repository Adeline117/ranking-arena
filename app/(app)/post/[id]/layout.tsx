import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { BASE_URL } from '@/lib/constants/urls'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const resolvedParams = await params
  const postId = resolvedParams.id
  const canonicalUrl = `${BASE_URL}/post/${postId}`
  
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data: post } = await supabase
      .from('posts')
      .select('id, title, content, author_handle, created_at, images')
      .eq('id', postId)
      .maybeSingle()
    
    if (post) {
      const title = `${post.title.slice(0, 60)} · Arena`
      const description = post.content 
        ? post.content.slice(0, 160) + (post.content.length > 160 ? '...' : '')
        : `Post by ${post.author_handle}`
      
      // 获取第一张图片作为 OG 图片
      const images = post.images as string[] | null
      const ogImage = images?.[0]
      
      return {
        title,
        description,
        alternates: {
          canonical: canonicalUrl,
        },
        openGraph: {
          title: post.title,
          description,
          type: 'article',
          url: canonicalUrl,
          siteName: 'Arena',
          publishedTime: post.created_at,
          authors: [`${BASE_URL}/u/${encodeURIComponent(post.author_handle)}`],
          images: ogImage ? [{
            url: ogImage,
            width: 1200,
            height: 630,
            alt: post.title,
          }] : undefined,
        },
        twitter: {
          card: ogImage ? 'summary_large_image' : 'summary',
          title: post.title,
          description,
          images: ogImage ? [ogImage] : undefined,
          creator: '@arenafi',
        },
        robots: {
          index: true,
          follow: true,
        },
      }
    }
  } catch (error) {
    logger.error('[Metadata] Failed to generate post metadata:', error)
  }
  
  return {
    title: 'Post',
    description: 'View post details',
    alternates: {
      canonical: canonicalUrl,
    },
  }
}

export default function PostLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
