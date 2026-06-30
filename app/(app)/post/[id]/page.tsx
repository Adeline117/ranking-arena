import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { features } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getPostById } from '@/lib/data/posts'
import PostDetailPageBody from './PostDetailPageBody'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generatePostArticleSchema } from '@/lib/seo/structured-data'
import { BASE_URL as APP_URL } from '@/lib/constants/urls'

export const revalidate = 60

// Single fetch shared between generateMetadata and the page (request-deduped).
const getPost = cache(async (id: string) => {
  try {
    return await getPostById(getSupabaseAdmin(), id)
  } catch {
    return null
  }
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params

  try {
    const data = await getPost(id)

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
  const isValidId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^\d+$/.test(id)
  if (!isValidId) {
    notFound()
  }

  // Reuses cached result from generateMetadata — no extra DB query
  const post = await getPost(id)
  if (!post) {
    notFound()
  }

  // Server-side JSON-LD for crawlers
  const postJsonLd = generatePostArticleSchema({
    id: post.id,
    title: post.title,
    content: post.content ?? undefined,
    authorHandle: post.author_handle ?? 'anonymous',
    createdAt: post.created_at,
    updatedAt: post.updated_at ?? undefined,
    likeCount: post.like_count ?? undefined,
    commentCount: post.comment_count ?? undefined,
    viewCount: post.view_count ?? undefined,
  })

  return (
    <>
      <JsonLd data={postJsonLd} />
      {/* Client island — SSR-rendered with the server-fetched post (real HTML
          body for SEO/LCP); per-user state + i18n labels hydrate after mount. */}
      <PostDetailPageBody post={post} />
    </>
  )
}
