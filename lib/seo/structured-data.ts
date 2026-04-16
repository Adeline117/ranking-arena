/**
 * JSON-LD 结构化数据生成器
 * 用于 SEO 优化，支持 Google 富媒体搜索结果
 * @see https://schema.org
 * @see https://developers.google.com/search/docs/appearance/structured-data
 */

import { BASE_URL } from '@/lib/constants/urls'
const SITE_NAME = 'Arena'
// English-first description — site is primarily indexed in English. Using the
// Chinese-only "加密万物排行榜" caused Google Rich Results to show Chinese text
// on English search results, hurting CTR. Localized variants are handled via
// hreflang alternates in app/layout.tsx.
const SITE_DESCRIPTION = 'Crypto trader rankings across 30+ exchanges — ROI, Arena Score, and PnL leaderboards.'

// ============================================
// 类型定义
// ============================================

export interface WebSiteSchema {
  '@context': 'https://schema.org'
  '@type': 'WebSite'
  name: string
  url: string
  description?: string
  potentialAction?: SearchAction
  publisher?: OrganizationReference
}

export interface OrganizationSchema {
  '@context': 'https://schema.org'
  '@type': 'Organization'
  name: string
  url: string
  logo?: string
  description?: string
  sameAs?: string[]
  contactPoint?: ContactPoint
}

export interface PersonSchema {
  '@context': 'https://schema.org'
  '@type': 'Person'
  name: string
  url?: string
  image?: string
  description?: string
  identifier?: string
  jobTitle?: string
  sameAs?: string[]
}

export interface ProfilePageSchema {
  '@context': 'https://schema.org'
  '@type': 'ProfilePage'
  mainEntity: PersonSchema
  name: string
  url: string
  description?: string
  dateModified?: string
}

export interface ArticleSchema {
  '@context': 'https://schema.org'
  '@type': 'Article' | 'DiscussionForumPosting'
  headline: string
  description?: string
  author: PersonReference
  datePublished: string
  dateModified?: string
  url: string
  mainEntityOfPage?: string
  interactionStatistic?: InteractionCounter[]
  commentCount?: number
  publisher?: OrganizationReference
  image?: string[]
}

export interface CommentSchema {
  '@context': 'https://schema.org'
  '@type': 'Comment'
  text: string
  author: PersonReference
  datePublished: string
  parentItem?: { '@id': string }
}

export interface BreadcrumbListSchema {
  '@context': 'https://schema.org'
  '@type': 'BreadcrumbList'
  itemListElement: BreadcrumbItem[]
}

// 辅助类型
interface SearchAction {
  '@type': 'SearchAction'
  target: {
    '@type': 'EntryPoint'
    urlTemplate: string
  }
  'query-input': string
}

interface OrganizationReference {
  '@type': 'Organization'
  name: string
  url?: string
  logo?: string
}

interface PersonReference {
  '@type': 'Person'
  name: string
  url?: string
  image?: string
}

interface InteractionCounter {
  '@type': 'InteractionCounter'
  interactionType: string
  userInteractionCount: number
}

interface ContactPoint {
  '@type': 'ContactPoint'
  contactType: string
  email?: string
  url?: string
}

interface BreadcrumbItem {
  '@type': 'ListItem'
  position: number
  name: string
  item?: string
}

// ============================================
// 网站和组织 Schema
// ============================================

/**
 * 生成网站 Schema（用于首页）
 */
export function generateWebSiteSchema(): WebSiteSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: BASE_URL,
    description: SITE_DESCRIPTION,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${BASE_URL}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: BASE_URL,
      logo: `${BASE_URL}/logo.png`,
    },
  }
}

/**
 * 生成组织 Schema
 */
export function generateOrganizationSchema(): OrganizationSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: BASE_URL,
    logo: `${BASE_URL}/logo.png`,
    description: SITE_DESCRIPTION,
    sameAs: [
      'https://twitter.com/arenafi',
    ],
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer service',
      url: `${BASE_URL}/help`,
    },
  }
}

// ============================================
// 交易员 Schema
// ============================================

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderSchemaInput {
  handle: string
  id: string
  bio?: string
  avatarUrl?: string
  source?: string
  followers?: number
  roi90d?: number
  winRate?: number
  maxDrawdown?: number
  arenaScore?: number
  profileUrl?: string
}

/**
 * 生成交易员 Person Schema
 */
export function generateTraderPersonSchema(trader: TraderSchemaInput): PersonSchema {
  const personSchema: PersonSchema = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: trader.handle,
    identifier: trader.id,
    jobTitle: 'Crypto Trader',
  }
  
  if (trader.avatarUrl) {
    personSchema.image = trader.avatarUrl
  }
  
  // Build rich description with performance data
  const descParts: string[] = []
  if (trader.bio) descParts.push(trader.bio)
  if (trader.roi90d != null) {
    descParts.push(`90-day ROI: ${trader.roi90d >= 0 ? '+' : ''}${trader.roi90d.toFixed(2)}%`)
  }
  if (trader.winRate != null) descParts.push(`Win rate: ${trader.winRate.toFixed(1)}%`)
  if (trader.source) descParts.push(`Trading on ${trader.source.charAt(0).toUpperCase() + trader.source.slice(1)}`)
  personSchema.description = descParts.length > 0
    ? descParts.join(' · ')
    : `Crypto trader on ${SITE_NAME}`
  
  personSchema.url = `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}`
  
  // 添加交易所 profile 链接
  if (trader.profileUrl) {
    personSchema.sameAs = [trader.profileUrl]
  }
  
  return personSchema
}

/**
 * 生成交易员 ProfilePage Schema
 */
export function generateTraderProfilePageSchema(
  trader: TraderSchemaInput,
  lastModified?: string
): ProfilePageSchema {
  // Build description with performance data
  const descParts: string[] = []
  if (trader.bio) descParts.push(trader.bio.slice(0, 100))
  if (trader.roi90d != null) {
    descParts.push(`90D ROI: ${trader.roi90d >= 0 ? '+' : ''}${trader.roi90d.toFixed(2)}%`)
  }
  if (trader.winRate != null) descParts.push(`Win rate: ${trader.winRate.toFixed(1)}%`)
  if (trader.followers != null && trader.followers > 0) {
    descParts.push(`${trader.followers.toLocaleString()} followers`)
  }
  const description = descParts.length > 0
    ? descParts.join(' · ')
    : `View ${trader.handle}'s trading performance and portfolio on ${SITE_NAME}`

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: generateTraderPersonSchema(trader),
    name: `${trader.handle} - Crypto Trader Profile`,
    url: `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}`,
    description,
    dateModified: lastModified || new Date().toISOString(),
  }
}

// ============================================
// 帖子/文章 Schema
// ============================================

export interface PostSchemaInput {
  id: string
  title: string
  content?: string
  authorHandle: string
  authorAvatarUrl?: string
  createdAt: string
  updatedAt?: string
  likeCount?: number
  commentCount?: number
  viewCount?: number
  images?: string[]
  groupName?: string
}

/**
 * 生成帖子 Article Schema
 */
export function generatePostArticleSchema(post: PostSchemaInput): ArticleSchema {
  const schema: ArticleSchema = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: post.title.slice(0, 110), // Google 限制 110 字符
    url: `${BASE_URL}/post/${post.id}`,
    mainEntityOfPage: `${BASE_URL}/post/${post.id}`,
    datePublished: post.createdAt,
    author: {
      '@type': 'Person',
      name: post.authorHandle,
      url: `${BASE_URL}/u/${encodeURIComponent(post.authorHandle)}`,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: BASE_URL,
      logo: `${BASE_URL}/logo.png`,
    },
  }
  
  if (post.content) {
    schema.description = post.content.slice(0, 200)
  }
  
  if (post.updatedAt) {
    schema.dateModified = post.updatedAt
  }
  
  if (post.authorAvatarUrl) {
    schema.author.image = post.authorAvatarUrl
  }
  
  if (post.images && post.images.length > 0) {
    schema.image = post.images
  }
  
  // 互动统计
  const interactions: InteractionCounter[] = []
  
  if (post.likeCount !== undefined) {
    interactions.push({
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/LikeAction',
      userInteractionCount: post.likeCount,
    })
  }
  
  if (post.viewCount !== undefined) {
    interactions.push({
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/ViewAction',
      userInteractionCount: post.viewCount,
    })
  }
  
  if (interactions.length > 0) {
    schema.interactionStatistic = interactions
  }
  
  if (post.commentCount !== undefined) {
    schema.commentCount = post.commentCount
  }
  
  return schema
}

// ============================================
// 面包屑导航 Schema
// ============================================

export interface BreadcrumbInput {
  name: string
  url?: string
}

/**
 * 生成面包屑导航 Schema
 */
export function generateBreadcrumbSchema(items: BreadcrumbInput[]): BreadcrumbListSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  }
}

// ============================================
// 辅助函数
// ============================================

/**
 * 将 Schema 转换为 JSON-LD script 标签内容
 */
export function schemaToJsonLd(schema: object | object[]): string {
  return JSON.stringify(schema)
}

/**
 * 合并多个 Schema 为数组
 */
export function combineSchemas(...schemas: object[]): object[] {
  return schemas
}

// ============================================
// React 组件辅助
// ============================================

/**
 * 生成用于 Next.js metadata 的 JSON-LD 脚本
 * 用于页面的 generateMetadata 函数
 */
export function generateJsonLdMetadata(schema: object | object[]) {
  return {
    script: [
      {
        type: 'application/ld+json',
        text: schemaToJsonLd(schema),
      },
    ],
  }
}
