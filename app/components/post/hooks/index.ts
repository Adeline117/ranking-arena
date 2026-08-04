/**
 * Post Hooks Index
 *
 * Centralized export for all post-related custom hooks.
 * These hooks were extracted from PostFeed.tsx to improve
 * code organization and maintainability.
 */

export { usePostActions } from './usePostActions'
export { usePostTranslation } from './usePostTranslation'

// Re-export existing hooks
export { usePostComments, type Comment } from './usePostComments'
