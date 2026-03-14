import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const publicSupabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

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

        return {
          title,
          description,
          alternates: { canonical: `${baseUrl}/bot/${id}` },
          openGraph: {
            title: `${title} | Arena`,
            description,
            url: `${baseUrl}/bot/${id}`,
            siteName: 'Arena',
            type: 'website',
          },
          twitter: {
            card: 'summary',
            title: `${title} | Arena`,
            description,
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
