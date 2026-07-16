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

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/

export type HandleShapeError = 'required' | 'too_long' | 'whitespace_or_control' | null

export function getHandleCodePointLength(handle: string): number {
  return Array.from(handle).length
}

export function getHandleShapeError(handle: string): HandleShapeError {
  if (!handle) return 'required'
  if (handle !== handle.trim() || CONTROL_CHARACTER_PATTERN.test(handle)) {
    return 'whitespace_or_control'
  }
  if (getHandleCodePointLength(handle) > MAX_HANDLE_LENGTH) return 'too_long'
  return null
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase())
}

export function truncateHandle(handle: string): string {
  return Array.from(handle).slice(0, MAX_HANDLE_LENGTH).join('')
}
