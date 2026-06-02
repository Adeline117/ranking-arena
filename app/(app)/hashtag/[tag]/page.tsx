import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import HashtagClient from './HashtagClient'

interface HashtagPageProps {
  params: Promise<{ tag: string }>
}

export async function generateMetadata({ params }: HashtagPageProps): Promise<Metadata> {
  const { tag } = await params
  const decodedTag = decodeURIComponent(tag)
  const title = `#${decodedTag} - Arena`
  const description = `Posts tagged with #${decodedTag} on Arena, the crypto trader ranking platform.`

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/hashtag/${tag}` },
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
  const decodedTag = decodeURIComponent(tag)

  return <HashtagClient tag={decodedTag} />
}
