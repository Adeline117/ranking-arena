import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export async function generateMetadata({ params }: { params: { id: string } | Promise<{ id: string }> }): Promise<Metadata> {
  const resolvedParams = await params
  const postId = resolvedParams.id
  const canonicalUrl = `${BASE_URL}/post/${postId}`
  
  try {
    const supabase = getSupabaseAdmin()
    const { data: post } = await supabase
      .from('posts')
      .select('id, title, content, author_handle, created_at, images')
      .eq('id', postId)
      .maybeSingle()
    
    if (post) {
      const title = `${post.title.slice(0, 60)} · Arena`
      const description = post.content 
        ? post.content.slice(0, 160) + (post.content.length > 160 ? '...' : '')
        : `${post.author_handle} 发布的帖子`
      
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
    console.error('[Metadata] 生成post metadata失败:', error)
  }
  
  // 默认metadata
  return {
    title: '帖子 · Arena',
    description: '查看帖子详情',
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
