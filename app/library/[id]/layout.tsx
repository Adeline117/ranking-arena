import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const publicSupabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params

  try {
    if (publicSupabase) {
      const { data: book } = await publicSupabase
        .from('library_items')
        .select('title, author, description, cover_url, category')
        .eq('id', id)
        .maybeSingle()

      if (book) {
        const title = book.author ? `${book.title} - ${book.author}` : book.title
        const description = book.description
          ? book.description.substring(0, 160)
          : `${book.title}${book.author ? ` -- ${book.author}` : ''} | Arena 交易书库`
        const canonicalUrl = `${baseUrl}/library/${id}`

        return {
          title,
          description,
          alternates: {
            canonical: canonicalUrl,
          },
          openGraph: {
            title: `${title} | Arena`,
            description,
            type: 'book',
            url: canonicalUrl,
            siteName: 'Arena',
            images: book.cover_url
              ? [{ url: book.cover_url, alt: book.title }]
              : [{ url: `${baseUrl}/og-image.png`, alt: 'Arena' }],
          },
          twitter: {
            card: 'summary',
            title: `${title} | Arena`,
            description,
            images: book.cover_url ? [book.cover_url] : undefined,
          },
        }
      }
    }
  } catch (error) {
    logger.error('[Metadata] library item metadata error:', error)
  }

  return {
    title: '书库详情',
    description: 'Arena 交易书库 -- 精选加密货币交易书籍和教育资源。',
  }
}

export default function LibraryItemLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
