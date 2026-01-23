import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params

  let groupName = '小组'
  let groupDescription = '加入 Ranking Arena 社区小组，讨论交易策略和市场动态'

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    const { data: group } = await supabase
      .from('groups')
      .select('name, description, member_count')
      .eq('id', id)
      .maybeSingle()

    if (group) {
      groupName = group.name
      groupDescription = group.description || `${group.name} - ${group.member_count || 0} 位成员`
    }
  } catch {
    // 静默失败，使用默认元数据
  }

  const title = `${groupName} | Ranking Arena`

  return {
    title,
    description: groupDescription,
    openGraph: {
      title,
      description: groupDescription,
      type: 'website',
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
