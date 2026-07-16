import { cache } from 'react'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { features } from '@/lib/features'
import { createClient } from '@/lib/db'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getPostById } from '@/lib/data/posts'
import PostDetailPageBody from './PostDetailPageBody'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generatePostArticleSchema } from '@/lib/seo/structured-data'
import { BASE_URL as APP_URL } from '@/lib/constants/urls'

// The page body is viewer-scoped: group/paid visibility cannot be shared in
// ISR by post id. Metadata below still uses anonymous audience semantics.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const getPublicPost = cache(async (id: string) => {
  try {
    // This response is publicly cached by post id, so it must use anonymous
    // audience semantics. Viewer-specific group posts are loaded via APIs that
    // pass the authenticated actor instead of entering this shared cache.
    return await getPostById(getSupabaseAdmin(), id, null)
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
    const data = await getPublicPost(id)

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

  // Never put viewer-specific results in the anonymous metadata cache. The
  // RSC auth client reads the refreshed Supabase cookie for this request, then
  // the canonical database predicate decides the post audience/paywall.
  const cookieStore = await cookies()
  const authClient = createClient(cookieStore)
  const {
    data: { user },
  } = await authClient.auth.getUser()
  const post = user
    ? await getPostById(getSupabaseAdmin(), id, user.id).catch(() => null)
    : await getPublicPost(id)
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
