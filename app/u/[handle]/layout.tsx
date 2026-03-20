import { Metadata } from 'next'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const resolvedParams = await params
  const handle = decodeURIComponent(resolvedParams.handle)
  
  try {
    const supabase = getSupabaseAdmin()
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, bio, avatar_url')
      .eq('handle', handle)
      .maybeSingle()

    if (profile) {
      const title = `${profile.handle}`
      const canonicalUrl = `${BASE_URL}/u/${encodeURIComponent(handle)}`
      const description = profile.bio
        ? `${profile.bio.substring(0, 150)}${profile.bio.length > 150 ? '...' : ''}`
        : `查看 ${profile.handle} 的个人资料和交易动态。`

      return {
        title,
        description,
        alternates: {
          canonical: canonicalUrl,
        },
        openGraph: {
          title,
          description,
          type: 'profile',
          url: `${BASE_URL}/u/${encodeURIComponent(handle)}`,
          images: profile.avatar_url ? [profile.avatar_url] : undefined,
        },
        twitter: {
          card: 'summary',
          title,
          description,
          images: profile.avatar_url ? [profile.avatar_url] : undefined,
        },
      }
    }
  } catch (error) {
    logger.error('[Metadata] 生成user metadata失败:', error)
  }
  
  // 默认metadata
  return {
    title: handle,
    description: `View ${handle}'s profile and trading activity on Arena.`,
    alternates: {
      canonical: `${BASE_URL}/u/${encodeURIComponent(handle)}`,
    },
  }
}

export default function UserLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}

