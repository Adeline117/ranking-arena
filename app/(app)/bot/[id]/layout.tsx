import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const publicSupabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null

import { BASE_URL } from '@/lib/constants/urls'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params

  try {
    if (publicSupabase) {
      const { data: bot } = await publicSupabase
        .from('bot_rankings')
        .select('name, category, description, roi_7d, aum')
        .eq('id', id)
        .maybeSingle()

      if (bot) {
        const title = bot.name
        const description = bot.description
          ? bot.description.substring(0, 160)
          : `${bot.name} — ${bot.category || 'Trading Bot'} on Arena`

        const ogImage = `${BASE_URL}/api/og?title=${encodeURIComponent(bot.name)}&subtitle=${encodeURIComponent(bot.category || 'Trading Bot')}`

        return {
          title,
          description,
          alternates: { canonical: `${BASE_URL}/bot/${id}` },
          openGraph: {
            title,
            description,
            url: `${BASE_URL}/bot/${id}`,
            siteName: 'Arena',
            type: 'website',
            images: [{ url: ogImage, width: 1200, height: 630, alt: bot.name }],
          },
          twitter: {
            card: 'summary_large_image',
            title,
            description,
            creator: '@arenafi',
            images: [ogImage],
          },
        }
      }
    }
  } catch {
    // Intentionally swallowed: bot metadata fetch failed, default metadata used below
  }

  return {
    title: 'Bot Details',
    description: 'View bot performance, stats, and on-chain info on Arena.',
  }
}

export default function BotLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
