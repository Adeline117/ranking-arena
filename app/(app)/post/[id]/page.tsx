import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { features } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import PostDetailClient from './PostDetailClient'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generatePostArticleSchema } from '@/lib/seo/structured-data'
import { BASE_URL as APP_URL } from '@/lib/constants/urls'

export const revalidate = 60

const getPostMeta = cache(async (id: string) => {
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('posts')
      .select('id, title, content, author_handle, created_at, updated_at, like_count, comment_count, view_count')
      .eq('id', id)
      .maybeSingle()
    return data
  } catch {
    return null
  }
})

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params

  try {
    const data = await getPostMeta(id)

    if (!data) {
      return { title: 'Post Not Found' }
    }

    const title = `${data.title} - @${data.author_handle}`
    const description = data.content?.slice(0, 160) || data.title

    const ogImage = `${APP_URL}/api/og?title=${encodeURIComponent(data.title.slice(0, 60))}&author=${encodeURIComponent(data.author_handle || '')}`

    return {
      title,
      description,
      alternates: { canonical: `${APP_URL}/post/${id}` },
      openGraph: {
        title: data.title,
        description,
        url: `${APP_URL}/post/${id}`,
        type: 'article',
        publishedTime: data.created_at,
        authors: [`@${data.author_handle}`],
        siteName: 'Arena',
        images: [{ url: ogImage, width: 1200, height: 630 }],
      },
      twitter: {
        card: 'summary_large_image',
        title: data.title,
        description,
        creator: '@arenafi',
        images: [ogImage],
      },
    }
  } catch {
    return { title: 'Post' }
  }
}

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!features.social) redirect('/')

  const { id } = await params

  // Validate id format (UUID or numeric)
  const isValidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^\d+$/.test(id)
  if (!isValidId) {
    notFound()
  }

  // Reuses cached result from generateMetadata — no extra DB query
  const data = await getPostMeta(id)
  if (!data) {
    notFound()
  }

  // Server-side JSON-LD for crawlers (client component also renders it after hydration)
  const postJsonLd = generatePostArticleSchema({
    id: data.id,
    title: data.title,
    content: data.content ?? undefined,
    authorHandle: data.author_handle ?? 'anonymous',
    createdAt: data.created_at,
    updatedAt: data.updated_at ?? undefined,
    likeCount: data.like_count ?? undefined,
    commentCount: data.comment_count ?? undefined,
    viewCount: data.view_count ?? undefined,
  })

  return (
    <>
      <JsonLd data={postJsonLd} />
      <PostDetailClient postId={id} />
    </>
  )
}
