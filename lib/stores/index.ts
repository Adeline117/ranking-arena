/**
 * Zustand 状态管理
 * 提供轻量级的全局状态管理
 *
 * 实际使用的 Stores:
 * - useComparisonStore: 交易员对比功能 (lib/stores/comparisonStore.ts)
 * - usePostStore: 帖子和评论管理 (lib/stores/postStore.ts)
 * - useInboxStore: 收件箱和通知 (lib/stores/inboxStore.ts)
 * - useMultiAccountStore: 多账户管理 (lib/stores/multiAccountStore.ts)
 *
 * NOTE: Prefer importing stores directly from their own files to avoid
 * barrel-import bloat (e.g. `import { useComparisonStore } from '@/lib/stores/comparisonStore'`).
 * This barrel re-export is kept for backward compatibility.
 *
 * 其他状态管理方式:
 * - 排行榜数据: useTraderData hook + SWR
 * - 用户认证: Supabase Auth + useAuth hook
 * - UI 状态: LanguageProvider + ThemeProvider + 各组件 useState
 */

// ============================================
// Re-export all stores
// ============================================

export { useComparisonStore, type CompareTrader } from './comparisonStore'
export { usePostStore, type PostData, type CommentData } from './postStore'
export { useInboxStore } from './inboxStore'
export { useMultiAccountStore, type StoredAccount } from './multiAccountStore'
