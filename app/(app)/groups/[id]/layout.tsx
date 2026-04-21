import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { BASE_URL } from '@/lib/constants/urls'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params

  let groupName = 'Group'
  let groupDescription = 'Join this trading group on Arena to discuss strategies and market trends.'
  let memberCount = 0

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    const { data: group } = await supabase
      .from('groups')
      .select('name, description, member_count')
      .eq('id', id)
      .maybeSingle()

    if (group) {
      groupName = group.name
      memberCount = group.member_count || 0
      groupDescription = group.description || `${group.name} — ${memberCount} members on Arena`
    }
  } catch {
    // Intentionally swallowed: metadata generation failure is non-critical, default metadata used
  }

  const title = `${groupName} · Arena`
  const ogImage = `${BASE_URL}/api/og?title=${encodeURIComponent(groupName)}&subtitle=${encodeURIComponent(`${memberCount} members`)}`

  return {
    title,
    description: groupDescription,
    alternates: {
      canonical: `${BASE_URL}/groups/${id}`,
    },
    openGraph: {
      title,
      description: groupDescription,
      url: `${BASE_URL}/groups/${id}`,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: groupName }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: groupDescription,
      creator: '@arenafi',
      images: [ogImage],
    },
  }
}

export default function GroupLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
