/**
 * Post Hooks Index
 *
 * Centralized export for all post-related custom hooks.
 * These hooks were extracted from PostFeed.tsx to improve
 * code organization and maintainability.
 */

export { usePostFeedData, type UsePostFeedDataOptions, type UsePostFeedDataReturn } from './usePostFeedData'
export { usePostActions, type UsePostActionsOptions, type UsePostActionsReturn } from './usePostActions'
export { usePostTranslation, type UsePostTranslationOptions, type UsePostTranslationReturn } from './usePostTranslation'

// Re-export existing hooks
export { usePostComments, type Comment } from './usePostComments'
export { useBookmarkRepost } from './useBookmarkRepost'
