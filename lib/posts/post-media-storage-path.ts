const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VIDEO_OBJECT_PATTERN = /^([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\.(mp4|mov|webm|mkv|avi)$/i
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"'`()\[\]]+/giu

export const MAX_POST_VIDEO_CLEANUP_CANDIDATES = 8

function readStorageOrigin(storageBaseUrl: string): string | null {
  try {
    const parsed = new URL(storageBaseUrl)
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Turns a public post-video URL into its Storage object path only when the URL
 * is canonical and the first path segment is the authenticated owner. This is
 * deliberately independent of any client-provided fileName.
 */
export function readOwnedPostVideoObjectPath(
  value: unknown,
  ownerId: string,
  storageBaseUrl: string
): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim() ||
    !UUID_PATTERN.test(ownerId)
  ) {
    return null
  }

  const storageOrigin = readStorageOrigin(storageBaseUrl)
  if (!storageOrigin) return null

  try {
    const parsed = new URL(value)
    const publicPrefix = '/storage/v1/object/public/posts/'
    if (
      parsed.origin !== storageOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.startsWith(publicPrefix)
    ) {
      return null
    }

    const objectPath = parsed.pathname.slice(publicPrefix.length)
    const match = objectPath.match(VIDEO_OBJECT_PATTERN)
    if (
      !match ||
      !UUID_PATTERN.test(match[1]) ||
      !UUID_PATTERN.test(match[2]) ||
      match[1].toLowerCase() !== ownerId.toLowerCase() ||
      objectPath !== objectPath.toLowerCase()
    ) {
      return null
    }

    return objectPath
  } catch {
    return null
  }
}

/**
 * Extracts a bounded, deduplicated set of owner-bound video object paths from
 * a post body captured from the database before that post is deleted.
 */
export function collectOwnedPostVideoObjectPaths(
  content: unknown,
  ownerId: string,
  storageBaseUrl: string
): string[] {
  if (typeof content !== 'string' || content.length === 0) return []

  const paths = new Set<string>()
  for (const candidate of content.match(URL_CANDIDATE_PATTERN) ?? []) {
    const path = readOwnedPostVideoObjectPath(candidate, ownerId, storageBaseUrl)
    if (path) paths.add(path)
    if (paths.size >= MAX_POST_VIDEO_CLEANUP_CANDIDATES) break
  }
  return [...paths]
}

export function postVideoPublicPathMarker(objectPath: string): string {
  return `/storage/v1/object/public/posts/${objectPath}`
}
