import type { SupabaseClient } from '@supabase/supabase-js'

export const CHAT_MEDIA_BUCKET = 'chat'
export const CHAT_MEDIA_SIGNED_URL_TTL_SECONDS = 15 * 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CHAT_OBJECT_PATH_PATTERN =
  /^\/storage\/v1\/object\/(?:authenticated|public|sign)\/chat\/(.+)$/
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,180}$/
const CHAT_MEDIA_CATEGORIES = new Set(['image', 'video', 'file'])

export type ChatMediaRow = { media_url: string | null }

export interface ParsedChatMediaUrl {
  objectName: string
  scopeId: string
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.includes('/') || decoded.includes('\\') ? null : decoded
  } catch {
    return null
  }
}

/**
 * Recognize only canonical objects created by the chat uploader. Both legacy
 * public URLs and expiring signed URLs are accepted so existing rows can be
 * migrated lazily without ever returning the legacy URL to a reader.
 */
export function parseChatMediaUrl(
  rawUrl: string,
  expectedScopeId: string
): ParsedChatMediaUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null

  const pathMatch = CHAT_OBJECT_PATH_PATTERN.exec(url.pathname)
  if (!pathMatch) return null

  const rawSegments = pathMatch[1]?.split('/')
  if (!rawSegments || rawSegments.length !== 3) return null

  const segments = rawSegments.map(decodePathSegment)
  if (segments.some((segment) => segment === null)) return null

  const [scopeId, category, fileName] = segments as [string, string, string]
  const canonicalScopeId = scopeId.toLowerCase()
  if (
    !UUID_PATTERN.test(canonicalScopeId) ||
    canonicalScopeId !== expectedScopeId.toLowerCase() ||
    !CHAT_MEDIA_CATEGORIES.has(category) ||
    !SAFE_FILE_NAME_PATTERN.test(fileName) ||
    fileName === '.' ||
    fileName === '..'
  ) {
    return null
  }

  return {
    scopeId: canonicalScopeId,
    objectName: `${canonicalScopeId}/${category}/${fileName}`,
  }
}

function looksLikeChatStorageUrl(rawUrl: string): boolean {
  try {
    return CHAT_OBJECT_PATH_PATTERN.test(new URL(rawUrl).pathname)
  } catch {
    return false
  }
}

/**
 * Re-sign chat media only after the caller has authorized the containing
 * conversation/channel. Recognized-but-invalid or un-signable chat URLs are
 * removed fail-closed; unrelated HTTPS attachment URLs remain untouched.
 */
export async function refreshAuthorizedChatMediaUrls<T extends ChatMediaRow>(
  supabase: SupabaseClient,
  rows: T[],
  expectedScopeId: string
): Promise<T[]> {
  const parsedByIndex = rows.map((row) =>
    row.media_url ? parseChatMediaUrl(row.media_url, expectedScopeId) : null
  )
  const recognizedIndexes = rows
    .map((row, index) => (row.media_url && looksLikeChatStorageUrl(row.media_url) ? index : null))
    .filter((index): index is number => index !== null)

  if (recognizedIndexes.length === 0) return rows

  const requestedPaths = Array.from(
    new Set(
      recognizedIndexes
        .map((index) => parsedByIndex[index]?.objectName)
        .filter((path): path is string => Boolean(path))
    )
  )
  if (requestedPaths.length === 0) {
    return rows.map((row, index) =>
      recognizedIndexes.includes(index) ? { ...row, media_url: null } : row
    )
  }

  const { data, error } = await supabase.storage
    .from(CHAT_MEDIA_BUCKET)
    .createSignedUrls(requestedPaths, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS)
    .catch(() => ({ data: null, error: new Error('Chat media signing failed') }))

  const signedByPath = new Map<string, string>()
  if (!error && data && data.length === requestedPaths.length) {
    for (let index = 0; index < requestedPaths.length; index += 1) {
      const entry = data[index]
      const expectedPath = requestedPaths[index]
      if (
        !entry ||
        entry.error ||
        entry.path !== expectedPath ||
        typeof entry.signedUrl !== 'string' ||
        parseChatMediaUrl(entry.signedUrl, expectedScopeId)?.objectName !== expectedPath
      ) {
        signedByPath.clear()
        break
      }
      signedByPath.set(expectedPath, entry.signedUrl)
    }
  }

  return rows.map((row, index) => {
    if (!recognizedIndexes.includes(index)) return row
    const objectName = parsedByIndex[index]?.objectName
    return { ...row, media_url: objectName ? (signedByPath.get(objectName) ?? null) : null }
  })
}
