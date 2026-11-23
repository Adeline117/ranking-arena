import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import HashtagClient from './HashtagClient'

interface HashtagPageProps {
  params: Promise<{ tag: string }>
}

// 畸形的 % 序列会让 decodeURIComponent 抛 URIError（→ 500）。
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export async function generateMetadata({ params }: HashtagPageProps): Promise<Metadata> {
  const { tag } = await params
  const decodedTag = safeDecode(tag)
  const title = `#${decodedTag} - Arena`
  const description = `Posts tagged with #${decodedTag} on Arena, the crypto trader ranking platform.`

  return {
    title,
    description,
    // 任意字符串、任意大小写都能打开这个页面，且帖子列表只在客户端加载，
    // 服务端 HTML 没有内容：不收录，只让爬虫沿链接继续走。
    robots: { index: false, follow: true },
    alternates: {
      canonical: `${BASE_URL}/hashtag/${encodeURIComponent(decodedTag.toLowerCase())}`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/hashtag/${tag}`,
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

export default async function HashtagPage({ params }: HashtagPageProps) {
  const { tag } = await params
  const decodedTag = safeDecode(tag)

  return <HashtagClient tag={decodedTag} />
}
