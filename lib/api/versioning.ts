/**
 * API 版本管理
 * 提供版本化路由和向后兼容支持
 */

import { NextRequest, NextResponse } from 'next/server'

// ============================================
// 版本配置
// ============================================

export const API_VERSIONS = ['v1', 'v2'] as const
export type ApiVersion = typeof API_VERSIONS[number]

export const CURRENT_VERSION: ApiVersion = 'v1'
export const DEPRECATED_VERSIONS: ApiVersion[] = []

// ============================================
// 版本检测
// ============================================

/**
 * 从请求中提取 API 版本
 * 支持: URL 路径 (/api/v1/...) 或 Header (X-API-Version: v1)
 */
export function extractApiVersion(request: NextRequest): ApiVersion {
  // 1. 检查 URL 路径
  const pathname = request.nextUrl.pathname
  const versionMatch = pathname.match(/\/api\/(v\d+)\//)
  if (versionMatch && API_VERSIONS.includes(versionMatch[1] as ApiVersion)) {
    return versionMatch[1] as ApiVersion
  }

  // 2. 检查 Header
  const headerVersion = request.headers.get('X-API-Version')
  if (headerVersion && API_VERSIONS.includes(headerVersion as ApiVersion)) {
    return headerVersion as ApiVersion
  }

  // 3. 默认使用当前版本
  return CURRENT_VERSION
}

/**
 * 检查版本是否已弃用
 */
export function isDeprecated(version: ApiVersion): boolean {
  return DEPRECATED_VERSIONS.includes(version)
}

// ============================================
// 版本化响应
// ============================================

/**
 * 添加版本信息到响应头
 */
export function addVersionHeaders(
  response: NextResponse,
  version: ApiVersion
): NextResponse {
  response.headers.set('X-API-Version', version)
  response.headers.set('X-API-Current-Version', CURRENT_VERSION)
  
  if (isDeprecated(version)) {
    response.headers.set('X-API-Deprecated', 'true')
    response.headers.set('Deprecation', 'true')
    response.headers.set('Sunset', '2025-12-31') // 设置弃用截止日期
  }
  
  return response
}

// ============================================
// RESTful API 规范
// ============================================

/**
 * API 端点命名规范
 * 
 * 1. 资源使用复数名词
 * 2. 使用小写和连字符
 * 3. 层级关系使用嵌套路径
 * 
 * 示例:
 * - GET    /api/v1/traders           获取交易员列表
 * - GET    /api/v1/traders/:id       获取单个交易员
 * - GET    /api/v1/traders/:id/stats 获取交易员统计
 * - POST   /api/v1/posts             创建帖子
 * - PUT    /api/v1/posts/:id         更新帖子
 * - DELETE /api/v1/posts/:id         删除帖子
 * - GET    /api/v1/users/:id/follows 获取用户关注列表
 * - POST   /api/v1/traders/:id/follow 关注交易员
 */

export const ApiEndpoints = {
  // 交易员
  traders: {
    list: '/api/v1/traders',
    detail: (id: string) => `/api/v1/traders/${id}`,
    stats: (id: string) => `/api/v1/traders/${id}/stats`,
    performance: (id: string) => `/api/v1/traders/${id}/performance`,
    portfolio: (id: string) => `/api/v1/traders/${id}/portfolio`,
    history: (id: string) => `/api/v1/traders/${id}/history`,
    similar: (id: string) => `/api/v1/traders/${id}/similar`,
    follow: (id: string) => `/api/v1/traders/${id}/follow`,
  },
  
  // 帖子
  posts: {
    list: '/api/v1/posts',
    detail: (id: string) => `/api/v1/posts/${id}`,
    comments: (id: string) => `/api/v1/posts/${id}/comments`,
    like: (id: string) => `/api/v1/posts/${id}/like`,
    repost: (id: string) => `/api/v1/posts/${id}/repost`,
  },
  
  // 评论
  comments: {
    detail: (id: string) => `/api/v1/comments/${id}`,
    like: (id: string) => `/api/v1/comments/${id}/like`,
  },
  
  // 用户
  users: {
    profile: (handle: string) => `/api/v1/users/${handle}`,
    follows: (handle: string) => `/api/v1/users/${handle}/follows`,
    posts: (handle: string) => `/api/v1/users/${handle}/posts`,
  },
  
  // 市场
  market: {
    prices: '/api/v1/market/prices',
    ticker: (symbol: string) => `/api/v1/market/ticker/${symbol}`,
  },
  
  // 搜索
  search: {
    traders: '/api/v1/search/traders',
    posts: '/api/v1/search/posts',
    suggestions: '/api/v1/search/suggestions',
  },
  
  // 通知
  notifications: {
    list: '/api/v1/notifications',
    markRead: (id: string) => `/api/v1/notifications/${id}/read`,
    markAllRead: '/api/v1/notifications/read-all',
  },
  
  // 认证
  auth: {
    login: '/api/v1/auth/login',
    logout: '/api/v1/auth/logout',
    refresh: '/api/v1/auth/refresh',
    verify: '/api/v1/auth/verify',
  },
} as const

// ============================================
// HTTP 状态码规范
// ============================================

export const HttpStatus = {
  // 成功
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  
  // 重定向
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  
  // 客户端错误
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  GONE: 410,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  
  // 服务端错误
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const

// ============================================
// 分页规范
// ============================================

export interface PaginationParams {
  page?: number      // 页码（从 1 开始）
  limit?: number     // 每页数量
  cursor?: string    // 游标（用于游标分页）
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
  nextCursor?: string
}

/**
 * 解析分页参数
 */
export function parsePaginationParams(
  searchParams: URLSearchParams,
  defaults: { page?: number; limit?: number } = {}
): PaginationParams {
  const page = parseInt(searchParams.get('page') || String(defaults.page || 1), 10)
  const limit = parseInt(searchParams.get('limit') || String(defaults.limit || 20), 10)
  const cursor = searchParams.get('cursor') || undefined

  return {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    cursor,
  }
}

/**
 * 构建分页元数据
 */
export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit)
  
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  }
}
