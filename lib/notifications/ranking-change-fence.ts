/**
 * The legacy ranking-change notification payload has no immutable historical
 * evidence contract. Treat every persisted instance as unavailable until a
 * reviewed replacement explicitly changes this policy and cache epoch.
 */

export const NOTIFICATION_READER_CACHE_EPOCH = 'ranking-change-fence-v1'
export const SUPPRESSED_NOTIFICATION_TYPE = 'ranking_change' as const

export function isVisibleNotificationType(type: unknown): boolean {
  return type !== SUPPRESSED_NOTIFICATION_TYPE
}
