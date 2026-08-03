const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IMAGE_PATH_PATTERN = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpg|png|gif|webp|avif)$/i
const VIDEO_PATH_PATTERN = /^([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})\.(mp4|mov|webm|mkv|avi)$/i

const VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
}

export type PostImageUploadAcknowledgement = Readonly<{
  url: string
  fileName: string
}>

export type PostVideoUploadAcknowledgement = Readonly<{
  url: string
  fileName: string
  fileSize: number
  fileType: string
}>

export function readPostMediaUploadError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null
  const message = value.error.trim()
  return message.length > 0 && message.length <= 500 ? message : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isCanonicalPublicObjectUrl(
  value: unknown,
  fileName: string,
  storageBaseUrl: string
): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }

  try {
    const parsed = new URL(value)
    const storageBase = new URL(storageBaseUrl)
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== storageBase.origin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return false
    }
    const decodedPath = decodeURIComponent(parsed.pathname)
    return decodedPath.endsWith(`/storage/v1/object/public/posts/${fileName}`)
  } catch {
    return false
  }
}

function pathBelongsToOwner(value: unknown, ownerId: string, pattern: RegExp): value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(ownerId)) return false
  const match = value.match(pattern)
  return Boolean(
    match &&
    UUID_PATTERN.test(match[1]) &&
    UUID_PATTERN.test(match[2]) &&
    match[1].toLowerCase() === ownerId.toLowerCase()
  )
}

export function readPostImageUploadAcknowledgement(
  value: unknown,
  ownerId: string,
  storageBaseUrl: string
): PostImageUploadAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['url', 'fileName', 'verified']) ||
    value.verified !== true ||
    !pathBelongsToOwner(value.fileName, ownerId, IMAGE_PATH_PATTERN) ||
    !isCanonicalPublicObjectUrl(value.url, value.fileName, storageBaseUrl)
  ) {
    return null
  }

  return { url: value.url, fileName: value.fileName }
}

export function readPostVideoUploadAcknowledgement(
  value: unknown,
  ownerId: string,
  storageBaseUrl: string
): PostVideoUploadAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['url', 'fileName', 'fileSize', 'fileType']) ||
    !pathBelongsToOwner(value.fileName, ownerId, VIDEO_PATH_PATTERN) ||
    !Number.isSafeInteger(value.fileSize) ||
    Number(value.fileSize) <= 0 ||
    Number(value.fileSize) > 100 * 1024 * 1024 ||
    typeof value.fileType !== 'string' ||
    !isCanonicalPublicObjectUrl(value.url, value.fileName, storageBaseUrl)
  ) {
    return null
  }

  const extension = value.fileName.slice(value.fileName.lastIndexOf('.') + 1).toLowerCase()
  if (VIDEO_MIME_BY_EXTENSION[extension] !== value.fileType) return null

  return {
    url: value.url,
    fileName: value.fileName,
    fileSize: Number(value.fileSize),
    fileType: value.fileType,
  }
}
