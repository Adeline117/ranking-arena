import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { id } = await params

  // Try to fetch competition title/description for OG tags
  let title = 'Competition | Arena'
  let description = 'Compete with traders worldwide on Arena.'

  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('competitions')
      .select('title, description, metric, status, prize_pool_cents')
      .eq('id', id)
      .single()

    if (data) {
      const metricLabels: Record<string, string> = { roi: 'ROI', pnl: 'PnL', sharpe: 'Sharpe', max_drawdown: 'Max Drawdown' }
      const metricStr = metricLabels[data.metric] || data.metric
      const prize = data.prize_pool_cents > 0 ? ` | $${(data.prize_pool_cents / 100).toFixed(0)} Prize` : ''
      title = `${data.title} | Arena`
      description = data.description
        || `${data.status === 'completed' ? 'Completed' : data.status === 'active' ? 'Live' : 'Upcoming'} ${metricStr} competition${prize}. Join now on Arena.`
    }
  } catch {
    // Fall through with defaults
  }

  const url = `${BASE_URL}/competitions/${id}`

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${BASE_URL}/og-image.png`],
      creator: '@arenafi',
    },
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
