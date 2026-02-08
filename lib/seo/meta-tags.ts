/**
 * SEO & Social Preview Meta Tags
 * 
 * 生成 Open Graph 和 Twitter Card 元数据
 * 支持动态热门交易员预览卡片
 */

import type { Metadata } from 'next'

// ===== 类型定义 =====

export interface TopTrader {
  name: string
  avatar?: string
  roi: number
  platform: string
  rank: number
}

export interface PageMetaOptions {
  title?: string
  description?: string
  path?: string
  image?: string
  type?: 'website' | 'article' | 'profile'
  noIndex?: boolean
  // 动态数据
  topTraders?: TopTrader[]
  trader?: {
    name: string
    avatar?: string
    roi: number
    pnl: number
    platform: string
    winRate?: number
  }
}

// ===== 常量 =====

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://arena.trading'
const SITE_NAME = 'Ranking Arena'
const DEFAULT_DESCRIPTION = 'Discover top crypto traders across 20+ exchanges. Real-time performance rankings, ROI analysis, and copy trading insights.'
const DEFAULT_DESCRIPTION_ZH = '发现 20+ 交易所的顶级加密交易员。实时排行榜、ROI 分析和跟单洞察。'
const TWITTER_HANDLE = '@RankingArena'

// ===== OG 图片生成 =====

/**
 * 生成动态 OG 图片 URL
 */
export function generateOGImageUrl(options: {
  title: string
  subtitle?: string
  topTraders?: TopTrader[]
  trader?: PageMetaOptions['trader']
}): string {
  const params = new URLSearchParams()
  
  params.set('title', options.title)
  if (options.subtitle) params.set('subtitle', options.subtitle)
  
  // 添加热门交易员数据
  if (options.topTraders && options.topTraders.length > 0) {
    const tradersData = options.topTraders.slice(0, 3).map(t => ({
      n: t.name,
      r: t.roi.toFixed(1),
      p: t.platform,
    }))
    params.set('traders', JSON.stringify(tradersData))
  }
  
  // 添加单个交易员数据
  if (options.trader) {
    params.set('trader', JSON.stringify({
      n: options.trader.name,
      r: options.trader.roi.toFixed(1),
      pnl: options.trader.pnl.toFixed(0),
      p: options.trader.platform,
      wr: options.trader.winRate?.toFixed(1),
      a: options.trader.avatar,
    }))
  }
  
  return `${SITE_URL}/api/og?${params.toString()}`
}

// ===== Meta Tags 生成 =====

/**
 * 生成首页 Meta Tags
 */
export function generateHomeMetadata(
  topTraders?: TopTrader[],
  language: 'en' | 'zh' = 'en'
): Metadata {
  const title = language === 'zh' 
    ? 'Ranking Arena | 加密交易员排行榜' 
    : 'Ranking Arena | Crypto Trader Rankings'
  
  const description = language === 'zh' ? DEFAULT_DESCRIPTION_ZH : DEFAULT_DESCRIPTION
  
  // 如果有热门交易员，添加到描述
  let enhancedDesc = description
  if (topTraders && topTraders.length > 0) {
    const topNames = topTraders.slice(0, 3).map(t => t.name).join(', ')
    enhancedDesc = language === 'zh'
      ? `今日热门: ${topNames}。${description}`
      : `Trending: ${topNames}. ${description}`
  }

  return {
    title,
    description: enhancedDesc,
    openGraph: {
      title,
      description: enhancedDesc,
      url: SITE_URL,
      siteName: SITE_NAME,
      images: [
        {
          url: generateOGImageUrl({
            title: language === 'zh' ? '加密交易员排行榜' : 'Crypto Trader Rankings',
            subtitle: language === 'zh' ? '发现顶级交易员' : 'Discover Top Traders',
            topTraders,
          }),
          width: 1200,
          height: 630,
          alt: 'Ranking Arena - Crypto Trader Rankings',
        },
      ],
      locale: language === 'zh' ? 'zh_CN' : 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: enhancedDesc,
      site: TWITTER_HANDLE,
      images: [generateOGImageUrl({
        title: language === 'zh' ? '加密交易员排行榜' : 'Crypto Trader Rankings',
        topTraders,
      })],
    },
    alternates: {
      canonical: SITE_URL,
      languages: {
        'en': `${SITE_URL}/en`,
        'zh': `${SITE_URL}/zh`,
      },
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  }
}

/**
 * 生成排行榜页面 Meta Tags
 */
export function generateRankingsMetadata(
  window: '7D' | '30D' | '90D',
  topTraders?: TopTrader[],
  language: 'en' | 'zh' = 'en'
): Metadata {
  const windowLabels = {
    '7D': language === 'zh' ? '7日' : '7 Day',
    '30D': language === 'zh' ? '30日' : '30 Day',
    '90D': language === 'zh' ? '90日' : '90 Day',
  }
  
  const title = language === 'zh'
    ? `${windowLabels[window]}排行榜 | Ranking Arena`
    : `${windowLabels[window]} Rankings | Ranking Arena`
  
  const description = language === 'zh'
    ? `查看 ${windowLabels[window]} 表现最佳的加密交易员。实时 ROI 和收益数据。`
    : `View top performing crypto traders over ${windowLabels[window]}. Real-time ROI and PnL data.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/rankings?window=${window}`,
      siteName: SITE_NAME,
      images: [
        {
          url: generateOGImageUrl({
            title: `${windowLabels[window]} ${language === 'zh' ? '排行榜' : 'Rankings'}`,
            subtitle: language === 'zh' ? '实时数据' : 'Real-time Data',
            topTraders,
          }),
          width: 1200,
          height: 630,
        },
      ],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: TWITTER_HANDLE,
    },
  }
}

/**
 * 生成交易员详情页 Meta Tags
 */
export function generateTraderMetadata(
  trader: PageMetaOptions['trader'],
  language: 'en' | 'zh' = 'en'
): Metadata {
  if (!trader) {
    return {
      title: 'Trader Not Found | Ranking Arena',
    }
  }

  const roiFormatted = trader.roi >= 0 ? `+${trader.roi.toFixed(1)}%` : `${trader.roi.toFixed(1)}%`

  const title = language === 'zh'
    ? `${trader.name} | ${roiFormatted} ROI | Ranking Arena`
    : `${trader.name} | ${roiFormatted} ROI | Ranking Arena`
  
  const description = language === 'zh'
    ? `${trader.name} 在 ${trader.platform} 的表现: ROI ${roiFormatted}, PnL $${trader.pnl.toLocaleString()}${trader.winRate ? `, 胜率 ${trader.winRate}%` : ''}`
    : `${trader.name}'s performance on ${trader.platform}: ROI ${roiFormatted}, PnL $${trader.pnl.toLocaleString()}${trader.winRate ? `, ${trader.winRate}% win rate` : ''}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/trader/${encodeURIComponent(trader.name)}`,
      siteName: SITE_NAME,
      images: [
        {
          url: generateOGImageUrl({
            title: trader.name,
            subtitle: `${roiFormatted} ROI on ${trader.platform}`,
            trader,
          }),
          width: 1200,
          height: 630,
        },
      ],
      type: 'profile',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: TWITTER_HANDLE,
    },
  }
}

/**
 * 生成通用页面 Meta Tags
 */
export function generatePageMetadata(options: PageMetaOptions): Metadata {
  const title = options.title 
    ? `${options.title} | Ranking Arena`
    : 'Ranking Arena'
  
  const description = options.description || DEFAULT_DESCRIPTION
  const url = options.path ? `${SITE_URL}${options.path}` : SITE_URL

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      images: options.image ? [{ url: options.image, width: 1200, height: 630 }] : undefined,
      type: options.type || 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: TWITTER_HANDLE,
    },
    robots: options.noIndex ? { index: false, follow: false } : undefined,
  }
}

// ===== JSON-LD 结构化数据 =====

/**
 * 生成网站 JSON-LD
 */
export function generateWebsiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_URL,
    description: DEFAULT_DESCRIPTION,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  }
}

/**
 * 生成交易员 JSON-LD
 */
export function generateTraderJsonLd(trader: NonNullable<PageMetaOptions['trader']>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: trader.name,
    image: trader.avatar,
    description: `Crypto trader on ${trader.platform} with ${trader.roi.toFixed(1)}% ROI`,
    url: `${SITE_URL}/trader/${encodeURIComponent(trader.name)}`,
    sameAs: [], // 可添加社交链接
  }
}

const metaTags = {
  generateHomeMetadata,
  generateRankingsMetadata,
  generateTraderMetadata,
  generatePageMetadata,
  generateOGImageUrl,
  generateWebsiteJsonLd,
  generateTraderJsonLd,
}

export default metaTags;
