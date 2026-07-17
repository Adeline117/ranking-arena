export const MAX_HANDLE_LENGTH = 30

export const RESERVED_HANDLE_VALUES = [
  'admin',
  'administrator',
  'arena',
  'moderator',
  'official',
  'root',
  'support',
  'system',
] as const

export const RESERVED_HANDLES = new Set<string>(RESERVED_HANDLE_VALUES)

// This alphabet mirrors the database trigger in
// 20260716179000_user_profile_handle_contract.sql.
// New handles are URL-segment safe. A dot is accepted only when Settings keeps
// one already-persisted legacy handle byte-for-byte unchanged.
export const NEW_HANDLE_PATTERN =
  /^[A-Za-z0-9_\u4E00-\u9FAF\u3041-\u309F\u30A0-\u30FF\uAC00-\uD7A3]+$/
const LEGACY_HANDLE_PATTERN = /^[A-Za-z0-9_.\u4E00-\u9FAF\u3041-\u309F\u30A0-\u30FF\uAC00-\uD7A3]+$/
const HANDLE_NAME_CHARACTER_PATTERN =
  /[A-Za-z0-9\u4E00-\u9FAF\u3041-\u309F\u30A0-\u30FF\uAC00-\uD7A3]/

export type HandleShapeError =
  | 'required'
  | 'too_long'
  | 'not_normalized'
  | 'invalid_characters'
  | 'missing_name_character'
  | null

export type HandleShapeOptions = {
  /** Only Settings may use this, and only for an exactly unchanged stored value. */
  allowUnchangedLegacyDot?: boolean
}

export function getHandleCodePointLength(handle: string): number {
  return Array.from(handle).length
}

export function normalizeHandle(handle: string): string {
  return handle.normalize('NFC')
}

export function getHandleShapeError(
  handle: string,
  options: HandleShapeOptions = {}
): HandleShapeError {
  if (!handle) return 'required'
  if (getHandleCodePointLength(handle) > MAX_HANDLE_LENGTH) return 'too_long'
  if (handle !== normalizeHandle(handle)) return 'not_normalized'

  const pattern = options.allowUnchangedLegacyDot ? LEGACY_HANDLE_PATTERN : NEW_HANDLE_PATTERN
  if (!pattern.test(handle)) return 'invalid_characters'
  if (!HANDLE_NAME_CHARACTER_PATTERN.test(handle)) return 'missing_name_character'
  return null
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase())
}

export function truncateHandle(handle: string): string {
  return Array.from(normalizeHandle(handle)).slice(0, MAX_HANDLE_LENGTH).join('')
}
