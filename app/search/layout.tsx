import type { Metadata } from 'next'

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}): Promise<Metadata> {
  const { q } = await searchParams
  const query = q?.trim()

  const title = query
    ? `"${query}" - 搜索结果 | Ranking Arena`
    : '搜索交易员 | Ranking Arena'

  const description = query
    ? `搜索 "${query}" 的交易员、帖子和小组结果`
    : '搜索排行榜上的交易员、社区帖子和讨论小组'

  return {
    title,
    description,
    openGraph: {
      title,
      description,
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
