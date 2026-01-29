import { Metadata } from 'next'
import { getTraderByHandle, getTraderPerformance } from '@/lib/data/trader'
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
    // Fetch profile and performance in parallel for richer metadata
    const [profile, performance] = await Promise.all([
      publicSupabase ? getTraderByHandle(handle) : null,
      publicSupabase ? getTraderPerformance(handle, '90D').catch(() => null) : null,
    ])
    
    if (profile) {
      // Build dynamic title with ROI when available
      const roiStr = performance?.roi_90d != null
        ? ` | 90D ROI: ${performance.roi_90d >= 0 ? '+' : ''}${performance.roi_90d.toFixed(2)}%`
        : ''
      const title = `${profile.handle}${roiStr}`

      // Build rich description with performance data
      const descParts: string[] = []
      if (profile.bio) {
        descParts.push(profile.bio.substring(0, 100))
      }
      if (performance?.roi_90d != null) {
        descParts.push(`90-day ROI: ${performance.roi_90d >= 0 ? '+' : ''}${performance.roi_90d.toFixed(2)}%`)
      }
      if (performance?.win_rate != null) {
        descParts.push(`Win rate: ${performance.win_rate.toFixed(1)}%`)
      }
      if (performance?.max_drawdown != null) {
        descParts.push(`Max drawdown: ${performance.max_drawdown.toFixed(1)}%`)
      }
      if (profile.followers != null && profile.followers > 0) {
        descParts.push(`${profile.followers.toLocaleString()} followers`)
      }
      if (profile.source) {
        descParts.push(`on ${profile.source.charAt(0).toUpperCase() + profile.source.slice(1)}`)
      }
      const description = descParts.length > 0
        ? descParts.join(' · ')
        : `View ${profile.handle}'s trader profile, ROI, win rate, and portfolio on Arena.`

      // Dynamic OG image with trader data
      const ogImageUrl = new URL(`${baseUrl}/api/og`)
      ogImageUrl.searchParams.set('handle', profile.handle)
      if (performance?.roi_90d != null) ogImageUrl.searchParams.set('roi', String(performance.roi_90d))
      if (performance?.win_rate != null) ogImageUrl.searchParams.set('winRate', String(performance.win_rate))
      if (performance?.max_drawdown != null) ogImageUrl.searchParams.set('mdd', String(performance.max_drawdown))
      if (performance?.arena_score != null) ogImageUrl.searchParams.set('score', String(performance.arena_score))
      if (profile.source) ogImageUrl.searchParams.set('source', profile.source)
      if (profile.avatar_url) ogImageUrl.searchParams.set('avatar', profile.avatar_url)
      
      return {
        title,
        description,
        alternates: {
          canonical: canonicalUrl,
        },
        keywords: [
          profile.handle,
          'crypto trader',
          'ROI',
          'copy trading',
          profile.source || '',
          'leaderboard',
          'Arena',
        ].filter(Boolean),
        openGraph: {
          title: `${profile.handle}${roiStr} · Arena`,
          description,
          type: 'profile',
          url: canonicalUrl,
          siteName: 'Arena',
          images: [{
            url: ogImageUrl.toString(),
            width: 1200,
            height: 630,
            alt: `${profile.handle}'s trader card on Arena`,
          }],
        },
        twitter: {
          card: 'summary_large_image',
          title: `${profile.handle}${roiStr} · Arena`,
          description,
          images: [ogImageUrl.toString()],
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
    description: `View ${handle}'s trader profile on Arena — crypto trader leaderboard & community.`,
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

