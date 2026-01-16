/**
 * 统一类型导出
 */

export * from './post'
export * from './comment'
export * from './notification'

/**
 * 通用分页响应
 */
export interface PaginationMeta {
  limit: number
  offset: number
  has_more: boolean
  total?: number
}

/**
 * API 响应基础类型
 */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  pagination?: PaginationMeta
}

/**
 * 用户基础信息
 */
export interface UserBasicInfo {
  id: string
  handle: string
  avatar_url?: string | null
  email?: string
}
