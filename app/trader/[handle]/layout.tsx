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
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
  const canonicalUrl = `${baseUrl}/trader/${encodeURIComponent(handle)}`
  
  try {
    const profile = adminSupabase ? await getTraderByHandle(handle) : null
    
    if (profile) {
      const title = `${profile.handle} · Arena`
      const description = profile.bio 
        ? `${profile.bio.substring(0, 150)}${profile.bio.length > 150 ? '...' : ''}`
        : `查看 ${profile.handle} 的交易员资料，包括90天ROI、胜率、粉丝数等统计数据。`
      
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
    description: `查看 ${handle} 的交易员资料`,
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

