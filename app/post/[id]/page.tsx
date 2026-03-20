import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { features } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import PostDetailClient from './PostDetailClient'
import { BASE_URL as APP_URL } from '@/lib/constants/urls'

export const revalidate = 60

const getPostMeta = cache(async (id: string) => {
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('posts')
      .select('id, title, content, author_handle, created_at')
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

    return {
      title,
      description,
      openGraph: {
        title: data.title,
        description,
        url: `${APP_URL}/post/${id}`,
        type: 'article',
        publishedTime: data.created_at,
        authors: [`@${data.author_handle}`],
        siteName: 'Arena',
        images: [`${APP_URL}/og-default.png`],
      },
      twitter: {
        card: 'summary_large_image',
        title: data.title,
        description,
        images: [`${APP_URL}/og-default.png`],
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

  return <PostDetailClient postId={id} />
}
