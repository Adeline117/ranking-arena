import type { Metadata } from 'next'
import HashtagClient from './HashtagClient'

interface HashtagPageProps {
  params: Promise<{ tag: string }>
}

export async function generateMetadata({ params }: HashtagPageProps): Promise<Metadata> {
  const { tag } = await params
  const decodedTag = decodeURIComponent(tag)

  return {
    title: `#${decodedTag} - Arena`,
    description: `Posts tagged with #${decodedTag} on Arena, the crypto trader ranking platform.`,
    openGraph: {
      title: `#${decodedTag} - Arena`,
      description: `Posts tagged with #${decodedTag} on Arena.`,
    },
  }
}

export default async function HashtagPage({ params }: HashtagPageProps) {
  const { tag } = await params
  const decodedTag = decodeURIComponent(tag)

  return <HashtagClient tag={decodedTag} />
}
