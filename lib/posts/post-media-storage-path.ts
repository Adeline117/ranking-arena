import { findMarkdownImageTokens } from './markdown-images'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IMAGE_OBJECT_PATTERN = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpg|png|gif|webp|avif)$/i
const VIDEO_OBJECT_PATTERN = /^([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\.(mp4|mov|webm|mkv|avi)$/i
// WHATWG special-scheme URLs do not require the literal `//` spelling: one or
// more forward/back slashes, mixed slashes, or no slash at all can still parse
// to the same HTTP(S) origin. Capture from the scheme colon so those aliases
// reach the canonical classifier and fail closed instead of disappearing from
// a post's final media manifest.
const URL_CANDIDATE_PATTERN = /https?:[^\s<>"'`()\[\]]+/giu
const PUBLIC_POSTS_PATH_PREFIX = '/storage/v1/object/public/posts/'
const PUBLIC_POSTS_PATH_STEM = PUBLIC_POSTS_PATH_PREFIX.slice(0, -1)

export const MAX_POST_VIDEO_CLEANUP_CANDIDATES = 8
export const MAX_POST_MEDIA_CLAIM_OBJECT_PATHS = 64

export type PostMediaStorageUrlClassification =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'external' }>
  | Readonly<{ kind: 'owned-image'; objectPath: string }>
  | Readonly<{ kind: 'owned-video'; objectPath: string }>
  | Readonly<{ kind: 'invalid-internal' }>
  | Readonly<{ kind: 'invalid-configuration' }>

export type PostMediaClaimObjectPathCollectionResult =
  | Readonly<{ kind: 'ok'; objectPaths: readonly string[] }>
  | Readonly<{ kind: 'invalid-reference' }>
  | Readonly<{ kind: 'invalid-configuration' }>

/**
 * Reads the canonical HTTP(S) origin used to identify managed post media.
 * Only a root URL, optionally followed by one trailing slash, is accepted so
 * deployment configuration cannot silently widen the managed-media boundary.
 */
export function readCanonicalPostMediaStorageOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null
  }

  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (value !== parsed.origin && value !== `${parsed.origin}/`)
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Classifies a post-media URL without allowing a malformed URL under this
 * deployment's public posts prefix to masquerade as an external asset.
 *
 * `invalid-configuration` is intentionally distinct from caller input errors:
 * a route can surface a server failure instead of blaming the user or silently
 * skipping a required upload claim.
 */
export function classifyPostMediaStorageUrl(
  value: unknown,
  ownerId: string,
  storageBaseUrl: string
): PostMediaStorageUrlClassification {
  if (value === null || value === undefined) return { kind: 'none' }
  if (typeof value === 'string' && value.trim().length === 0) return { kind: 'none' }

  const storageOrigin = readCanonicalPostMediaStorageOrigin(storageBaseUrl)
  if (!storageOrigin || typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
    return { kind: 'invalid-configuration' }
  }

  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return { kind: 'invalid-internal' }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { kind: 'invalid-internal' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { kind: 'invalid-internal' }
  }

  let decodedPathname: string | null = null
  let decodedValue: string | null = null
  try {
    decodedPathname = decodeURIComponent(parsed.pathname)
    decodedValue = decodeURIComponent(value)
  } catch {
    // A malformed escape under the managed prefix is rejected below instead
    // of being treated as an external URL.
  }

  const isPostsStorageCandidate =
    parsed.origin === storageOrigin &&
    (parsed.pathname.toLowerCase().startsWith(PUBLIC_POSTS_PATH_STEM) ||
      decodedPathname?.toLowerCase().startsWith(PUBLIC_POSTS_PATH_STEM) ||
      value.toLowerCase().includes(PUBLIC_POSTS_PATH_STEM) ||
      decodedValue?.toLowerCase().includes(PUBLIC_POSTS_PATH_STEM))

  if (!isPostsStorageCandidate) {
    if (parsed.username || parsed.password) return { kind: 'invalid-internal' }
    return { kind: 'external' }
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(PUBLIC_POSTS_PATH_PREFIX)
  ) {
    return { kind: 'invalid-internal' }
  }

  const objectPath = parsed.pathname.slice(PUBLIC_POSTS_PATH_PREFIX.length)
  const imageMatch = objectPath.match(IMAGE_OBJECT_PATTERN)
  const videoMatch = objectPath.match(VIDEO_OBJECT_PATTERN)
  const match = imageMatch ?? videoMatch
  if (
    !match ||
    !UUID_PATTERN.test(match[1]) ||
    !UUID_PATTERN.test(match[2]) ||
    match[1].toLowerCase() !== ownerId.toLowerCase() ||
    objectPath !== objectPath.toLowerCase() ||
    value !== `${storageOrigin}${PUBLIC_POSTS_PATH_PREFIX}${objectPath}`
  ) {
    return { kind: 'invalid-internal' }
  }

  return imageMatch ? { kind: 'owned-image', objectPath } : { kind: 'owned-video', objectPath }
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
  const classification = classifyPostMediaStorageUrl(value, ownerId, storageBaseUrl)
  return classification.kind === 'owned-video' ? classification.objectPath : null
}

function readPostContentUrlCandidates(content: unknown): readonly string[] {
  if (typeof content !== 'string' || content.length === 0) return []

  const candidates: string[] = content.match(URL_CANDIDATE_PATTERN) ?? []
  // Markdown destinations are already explicitly delimited. Keep their full
  // value so WHATWG-valid userinfo containing token delimiters (quotes,
  // brackets, tabs, or spaces) cannot hide a managed URL behind an apparently
  // external truncated prefix. Reuse the composer grammar to avoid drift.
  for (const token of findMarkdownImageTokens(content)) {
    candidates.push(token.url)
  }
  return candidates
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Builds the complete, owner-bound Storage manifest for the final post state.
 * Managed images may come from `images` or Markdown in `content`, while
 * managed videos may only come from URL candidates in `content`.
 * Client-provided upload file names are deliberately not accepted as an input
 * to this authority boundary.
 */
export function collectPostMediaClaimObjectPaths(
  images: readonly unknown[] | null,
  content: unknown,
  ownerId: string,
  storageBaseUrl: string
): PostMediaClaimObjectPathCollectionResult {
  if (!Array.isArray(images) && images !== null) return { kind: 'invalid-reference' }
  if (typeof content !== 'string') return { kind: 'invalid-reference' }

  // Validate server configuration even when the final post has no media. Empty
  // manifests still cross the same claim authority boundary as populated ones.
  if (!readCanonicalPostMediaStorageOrigin(storageBaseUrl) || !UUID_PATTERN.test(ownerId)) {
    return { kind: 'invalid-configuration' }
  }

  const objectPaths = new Set<string>()
  const addObjectPath = (objectPath: string): boolean => {
    objectPaths.add(objectPath)
    return objectPaths.size <= MAX_POST_MEDIA_CLAIM_OBJECT_PATHS
  }

  for (const image of images ?? []) {
    const classification = classifyPostMediaStorageUrl(image, ownerId, storageBaseUrl)
    switch (classification.kind) {
      case 'external':
        break
      case 'owned-image':
        if (!addObjectPath(classification.objectPath)) return { kind: 'invalid-reference' }
        break
      case 'invalid-configuration':
        return { kind: 'invalid-configuration' }
      case 'none':
      case 'owned-video':
      case 'invalid-internal':
        return { kind: 'invalid-reference' }
    }
  }

  for (const candidate of readPostContentUrlCandidates(content)) {
    const classification = classifyPostMediaStorageUrl(candidate, ownerId, storageBaseUrl)
    switch (classification.kind) {
      case 'external':
        break
      case 'owned-image':
      case 'owned-video':
        if (!addObjectPath(classification.objectPath)) return { kind: 'invalid-reference' }
        break
      case 'invalid-configuration':
        return { kind: 'invalid-configuration' }
      case 'none':
      case 'invalid-internal':
        return { kind: 'invalid-reference' }
    }
  }

  return { kind: 'ok', objectPaths: [...objectPaths].sort(compareAscii) }
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
  const paths = new Set<string>()
  for (const candidate of readPostContentUrlCandidates(content)) {
    const path = readOwnedPostVideoObjectPath(candidate, ownerId, storageBaseUrl)
    if (path) paths.add(path)
    if (paths.size >= MAX_POST_VIDEO_CLEANUP_CANDIDATES) break
  }
  return [...paths]
}

export function postVideoPublicPathMarker(objectPath: string): string {
  return `${PUBLIC_POSTS_PATH_PREFIX}${objectPath}`
}
