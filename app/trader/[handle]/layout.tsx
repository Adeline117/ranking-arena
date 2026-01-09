import { Metadata } from 'next'
import { getTraderByHandle } from '@/lib/data/trader'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const adminSupabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null

export async function generateMetadata({ params }: { params: { handle: string } | Promise<{ handle: string }> }): Promise<Metadata> {
  const resolvedParams = await params
  const handle = decodeURIComponent(resolvedParams.handle)
  
  try {
    const profile = adminSupabase ? await getTraderByHandle(handle) : null
    
    if (profile) {
      const title = `${profile.handle} · Ranking Arena`
      const description = profile.bio 
        ? `${profile.bio.substring(0, 150)}${profile.bio.length > 150 ? '...' : ''}`
        : `查看 ${profile.handle} 的交易员资料，包括90天ROI、胜率、粉丝数等统计数据。`
      
      return {
        title,
        description,
        openGraph: {
          title,
          description,
          type: 'profile',
          url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'}/trader/${encodeURIComponent(handle)}`,
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
    console.error('[Metadata] 生成trader metadata失败:', error)
  }
  
  // 默认metadata
  return {
    title: `${handle} · Ranking Arena`,
    description: `查看 ${handle} 的交易员资料`,
  }
}

export default function TraderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}

