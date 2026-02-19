import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import PostDetailClient from './PostDetailClient'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params

  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('posts')
      .select('title, content, author_handle, created_at')
      .eq('id', id)
      .maybeSingle()

    if (!data) {
      return { title: 'Post Not Found | Arena' }
    }

    const title = `${data.title} - @${data.author_handle} | Arena`
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
    return { title: 'Post | Arena' }
  }
}

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Validate id is a valid number and check existence
  const numId = Number(id)
  if (!Number.isFinite(numId) || numId < 1) {
    notFound()
  }

  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('posts')
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (!data) {
      notFound()
    }
  } catch {
    notFound()
  }

  return <PostDetailClient postId={id} />
}
