/**
 * SEO 元信息工具函数
 * 用于生成 Next.js generateMetadata 返回值
 */

import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
const SITE_NAME = 'Arena'
const DEFAULT_OG_IMAGE = `${BASE_URL}/og.png`
const TWITTER_HANDLE = '@arenafi'

// ============================================
// 类型定义
// ============================================

export interface PageMetadataInput {
  title: string
  description: string
  path: string
  type?: 'website' | 'article' | 'profile'
  image?: string | { url: string; width?: number; height?: number; alt?: string }
  publishedTime?: string
  modifiedTime?: string
  authors?: string[]
  noIndex?: boolean
  keywords?: string[]
}

// ============================================
// 基础构建函数
// ============================================

/**
 * 生成完整的页面 Metadata
 */
export function generatePageMetadata(input: PageMetadataInput): Metadata {
  const {
    title,
    description,
    path,
    type = 'website',
    image,
    publishedTime,
    modifiedTime,
    authors,
    noIndex = false,
    keywords,
  } = input
  
  const canonicalUrl = `${BASE_URL}${path}`
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} · ${SITE_NAME}`
  
  // 处理图片
  let ogImage: Array<{ url: string; width?: number; height?: number; alt?: string }> | undefined = undefined
  let twitterImage: string | undefined = undefined
  
  if (image) {
    if (typeof image === 'string') {
      ogImage = [{ url: image, alt: title }]
      twitterImage = image
    } else {
      ogImage = [{
        url: image.url,
        width: image.width,
        height: image.height,
        alt: image.alt || title,
      }]
      twitterImage = image.url
    }
  }
  
  const metadata: Metadata = {
    title: fullTitle,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: fullTitle,
      description,
      type: type as 'website' | 'article' | 'profile',
      url: canonicalUrl,
      siteName: SITE_NAME,
      images: ogImage || [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }],
      ...(publishedTime && { publishedTime }),
      ...(modifiedTime && { modifiedTime }),
      ...(authors && { authors }),
    },
    twitter: {
      card: twitterImage ? 'summary_large_image' : 'summary',
      title: fullTitle,
      description,
      images: twitterImage ? [twitterImage] : undefined,
      creator: TWITTER_HANDLE,
    },
    robots: noIndex ? {
      index: false,
      follow: false,
    } : {
      index: true,
      follow: true,
    },
  }
  
  if (keywords && keywords.length > 0) {
    metadata.keywords = keywords
  }
  
  return metadata
}

// ============================================
// 预设页面类型
// ============================================

/**
 * 交易员页面 Metadata
 */
export function generateTraderMetadata(trader: {
  handle: string
  bio?: string
  avatarUrl?: string
  followers?: number
  roi90d?: number
}): Metadata {
  const description = trader.bio 
    ? `${trader.bio.slice(0, 140)}${trader.bio.length > 140 ? '...' : ''}`
    : `查看 ${trader.handle} 的交易员资料${trader.roi90d ? `，90天ROI: ${trader.roi90d.toFixed(2)}%` : ''}`
  
  return generatePageMetadata({
    title: trader.handle,
    description,
    path: `/trader/${encodeURIComponent(trader.handle)}`,
    type: 'profile',
    image: trader.avatarUrl ? {
      url: trader.avatarUrl,
      width: 200,
      height: 200,
      alt: `${trader.handle}'s avatar`,
    } : undefined,
    keywords: ['交易员', 'crypto trader', trader.handle, 'ROI', '跟单'],
  })
}

/**
 * 帖子页面 Metadata
 */
export function generatePostMetadata(post: {
  id: string
  title: string
  content?: string
  authorHandle: string
  createdAt: string
  updatedAt?: string
  images?: string[]
}): Metadata {
  const description = post.content 
    ? post.content.slice(0, 160) + (post.content.length > 160 ? '...' : '')
    : `${post.authorHandle} 发布的帖子`
  
  return generatePageMetadata({
    title: post.title.slice(0, 60),
    description,
    path: `/post/${post.id}`,
    type: 'article',
    image: post.images?.[0] ? {
      url: post.images[0],
      width: 1200,
      height: 630,
      alt: post.title,
    } : undefined,
    publishedTime: post.createdAt,
    modifiedTime: post.updatedAt,
    authors: [`${BASE_URL}/u/${encodeURIComponent(post.authorHandle)}`],
  })
}

/**
 * 小组页面 Metadata
 */
export function generateGroupMetadata(group: {
  id: string
  name: string
  description?: string
  avatarUrl?: string
  memberCount?: number
}): Metadata {
  const description = group.description 
    ? group.description.slice(0, 160)
    : `加入 ${group.name} 小组${group.memberCount ? `，已有 ${group.memberCount} 名成员` : ''}`
  
  return generatePageMetadata({
    title: group.name,
    description,
    path: `/groups/${group.id}`,
    type: 'website',
    image: group.avatarUrl ? {
      url: group.avatarUrl,
      width: 200,
      height: 200,
      alt: group.name,
    } : undefined,
  })
}

/**
 * 搜索页面 Metadata
 */
export function generateSearchMetadata(query?: string): Metadata {
  const title = query ? `搜索: ${query}` : '搜索'
  const description = query 
    ? `在 Arena 搜索 "${query}" 的结果`
    : '搜索交易员、帖子和小组'
  
  return generatePageMetadata({
    title,
    description,
    path: query ? `/search?q=${encodeURIComponent(query)}` : '/search',
    noIndex: true, // 搜索结果页不索引
  })
}
