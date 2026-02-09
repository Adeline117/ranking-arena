import type { Metadata } from 'next'

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>
}): Promise<Metadata> {
  const resolved = searchParams ? await searchParams : {}
  const query = resolved.q?.trim()

  const title = query
    ? `"${query}" - 搜索结果 | Arena`
    : '搜索交易员 | Arena'

  const description = query
    ? `搜索 "${query}" 的交易员、帖子和小组结果`
    : '搜索排行榜上的交易员、社区帖子和讨论小组'

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/search`,
    },
    openGraph: {
      title,
      description,
      url: `${baseUrl}/search`,
      siteName: 'Arena',
      type: 'website',
    },
    robots: {
      index: !query, // 有搜索词时不索引（避免大量低质量页面）
      follow: true,
    },
  }
}

export default function SearchLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
