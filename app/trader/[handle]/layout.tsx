import { Metadata } from 'next'
import { getTraderByHandle } from '@/lib/data/trader'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
// 使用 anon key 而非 service role key，确保 RLS 策略被遵守
// 公开的 trader 信息应该通过 RLS 允许匿名读取
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const publicSupabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null

export async function generateMetadata({ params }: { params: { handle: string } | Promise<{ handle: string }> }): Promise<Metadata> {
  const resolvedParams = await params
  const handle = decodeURIComponent(resolvedParams.handle)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
  const canonicalUrl = `${baseUrl}/trader/${encodeURIComponent(handle)}`
  
  try {
    const profile = publicSupabase ? await getTraderByHandle(handle) : null
    
    if (profile) {
      const title = `${profile.handle} · Arena`
      const description = profile.bio 
        ? `${profile.bio.substring(0, 150)}${profile.bio.length > 150 ? '...' : ''}`
        : `View ${profile.handle}'s trader profile, including 90-day ROI, win rate, followers and more.`
      
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
          url: canonicalUrl,
          siteName: 'Arena',
          images: profile.avatar_url ? [{
            url: profile.avatar_url,
            width: 200,
            height: 200,
            alt: `${profile.handle}'s avatar`,
          }] : undefined,
        },
        twitter: {
          card: 'summary',
          title,
          description,
          images: profile.avatar_url ? [profile.avatar_url] : undefined,
          creator: '@arenafi',
        },
        robots: {
          index: true,
          follow: true,
        },
      }
    }
  } catch (error) {
    console.error('[Metadata] 生成trader metadata失败:', error)
  }
  
  // 默认metadata
  return {
    title: `${handle} · Arena`,
    description: `View ${handle}'s trader profile on Arena`,
    alternates: {
      canonical: canonicalUrl,
    },
  }
}

// 注释掉静态生成，使用 force-dynamic 动态渲染
// 原因：静态生成时 Upstash Redis 缓存调用会导致构建失败
// 
// export async function generateStaticParams() {
//   if (!adminSupabase) return []
//   try {
//     const { data } = await adminSupabase
//       .from('trader_sources')
//       .select('handle')
//       .not('handle', 'is', null)
//       .limit(50)
//     if (!data) return []
//     return data.filter(t => t.handle).map(t => ({ handle: encodeURIComponent(t.handle) }))
//   } catch (error) {
//     console.error('[generateStaticParams] Error:', error)
//     return []
//   }
// }

// 强制动态渲染，避免静态生成时 Upstash Redis 调用问题
export const dynamic = 'force-dynamic'

// ISR: 每小时重新生成静态页面（暂时禁用）
// export const revalidate = 3600

export default function TraderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}

