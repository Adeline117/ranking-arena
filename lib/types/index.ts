/**
 * 统一类型导出
 *
 * ============================================
 * 功能权限边界说明 (Login vs Pro)
 * ============================================
 *
 * 【登录级 - 免费用户登录后可用】
 * - 发帖、评论、点赞
 * - 收藏交易员/帖子
 * - 加入小组
 * - 关注用户
 * - 查看基础排行榜
 * - 私信（每日有限制）
 * - 个人资料编辑
 *
 * 【Pro级 - 需要Pro订阅】
 * - 排行榜高级筛选（交易所筛选、分类排名）
 * - 交易员详细持仓数据（PortfolioTable中canViewFull）
 * - 高级预警（AdvancedAlerts组件）
 * - 排行榜数据导出
 * - 移除广告
 *
 * 代码中的标识:
 * - isLoggedIn / requireLogin: 登录级检查
 * - isPro / canViewFull / onProRequired: Pro级检查
 * ============================================
 */

export * from './post'
export * from './comment'
export * from './notification'
export * from './trader'
export type { SubscriptionTier, ActiveSubscriptionTier } from './premium'
export { normalizeSubscriptionTier } from './premium'

// 导入供本文件内部使用
import type { SubscriptionTier } from './premium'

// ============================================
// 通用响应类型
// ============================================

/**
 * 通用分页元数据
 */
export interface PaginationMeta {
  limit: number
  offset: number
  has_more: boolean
  total?: number
}

/**
 * API 响应元数据
 */
export interface ResponseMeta {
  pagination?: PaginationMeta
  timestamp?: string
  requestId?: string
  /** 响应时间（毫秒） */
  duration?: number
}

/**
 * 成功响应类型
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true
  data: T
  meta?: ResponseMeta
}

/**
 * 错误详情
 */
export interface ApiErrorDetail {
  code: string
  message: string
  details?: Record<string, unknown>
  timestamp: string
  /** 字段级别的错误 */
  fieldErrors?: Record<string, string[]>
}

/**
 * 错误响应类型
 */
export interface ApiErrorResponse {
  success: false
  error: ApiErrorDetail
}

/**
 * 统一 API 响应类型（区分联合类型）
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse

/**
 * 类型守卫：判断是否为成功响应
 */
export function isApiSuccess<T>(response: ApiResponse<T>): response is ApiSuccessResponse<T> {
  return response.success === true
}

/**
 * 类型守卫：判断是否为错误响应
 */
export function isApiError<T>(response: ApiResponse<T>): response is ApiErrorResponse {
  return response.success === false
}

/**
 * 从响应中安全提取数据
 */
export function extractData<T>(response: ApiResponse<T>): T | null {
  return isApiSuccess(response) ? response.data : null
}

/**
 * 从响应中提取错误信息
 */
export function extractError(response: ApiResponse<unknown>): string | null {
  return isApiError(response) ? response.error.message : null
}

// ============================================
// 分页请求类型
// ============================================

/**
 * 通用分页请求参数（支持多种分页方式）
 * - offset: 偏移量分页
 * - cursor: 游标分页
 * - page: 页码分页（部分 API）
 */
export interface PaginationParams {
  limit?: number
  offset?: number
  cursor?: string
  /** 页码（部分 API 使用，从 1 开始） */
  page?: number
}

/**
 * 排序请求参数
 */
export interface SortParams<T extends string = string> {
  sortBy?: T
  sortOrder?: 'asc' | 'desc'
}

/**
 * 通用列表请求参数
 */
export interface ListParams<TSortField extends string = string> extends PaginationParams, SortParams<TSortField> {
  search?: string
  filter?: Record<string, string | number | boolean | string[]>
}

// ============================================
// 用户相关类型
// ============================================

/**
 * 用户基础信息
 */
export interface UserBasicInfo {
  id: string
  uid?: number | null // 数字用户编号
  handle: string
  avatar_url?: string | null
  email?: string
}

/**
 * 用户公开资料
 */
export interface UserProfile extends UserBasicInfo {
  bio?: string | null
  created_at: string
  follower_count: number
  following_count: number
  is_verified?: boolean
  subscription_tier?: SubscriptionTier
}

/**
 * 当前登录用户信息
 */
export interface CurrentUser extends UserProfile {
  email: string
  email_verified: boolean
  last_sign_in_at?: string
  app_metadata?: Record<string, unknown>
}

// ============================================
// 通用实体类型
// ============================================

/**
 * 带有时间戳的基础实体
 */
export interface BaseEntity {
  id: string
  created_at: string
  updated_at?: string
}

/**
 * 软删除实体
 */
export interface SoftDeletableEntity extends BaseEntity {
  deleted_at?: string | null
}

/**
 * 带有作者信息的实体
 */
export interface AuthoredEntity extends BaseEntity {
  author_id: string
  author?: UserBasicInfo
}

// ============================================
// Result Type (discriminated union for error handling)
// ============================================

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export function Ok<T>(data: T): Result<T, never> {
  return { ok: true, data }
}

export function Err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ============================================
// 操作结果类型
// ============================================

/**
 * 创建操作结果
 */
export interface CreateResult<T> {
  created: T
}

/**
 * 更新操作结果
 */
export interface UpdateResult<T> {
  updated: T
  changes?: Partial<T>
}

/**
 * 删除操作结果
 */
export interface DeleteResult {
  deleted: boolean
  id: string
}

/**
 * 批量操作结果
 */
export interface BatchResult<T> {
  succeeded: T[]
  failed: Array<{ id: string; error: string }>
  total: number
}

// ============================================
// 工具类型
// ============================================

/**
 * 使某些属性变为可选
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/**
 * 使某些属性变为必须
 */
export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

/**
 * 深度 Partial
 */
export type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: DeepPartial<T[P]>
} : T

/**
 * 非空类型
 */
export type NonNullableFields<T> = {
  [P in keyof T]: NonNullable<T[P]>
}

/**
 * 提取数组元素类型
 */
export type ArrayElement<T> = T extends readonly (infer U)[] ? U : never

/**
 * 提取函数返回类型（支持异步）
 */
export type AsyncReturnType<T extends (...args: unknown[]) => unknown> =
  T extends (...args: unknown[]) => Promise<infer U> ? U :
  T extends (...args: unknown[]) => infer U ? U : never
