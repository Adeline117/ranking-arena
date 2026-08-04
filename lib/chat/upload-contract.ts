import { parseChatMediaUrl } from '@/lib/chat/private-media'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

export type ChatUploadAcknowledgement = Readonly<{
  url: string
  fileName: string
  originalName: string
  fileType: string
  fileSize: number
  category: 'image' | 'video' | 'file'
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalSignedUrl(
  value: unknown,
  scopeId: string,
  objectName: string,
  storageBaseUrl: string
): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 4_096 ||
    CONTROL_PATTERN.test(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    const storageBase = new URL(storageBaseUrl)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === storageBase.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname.startsWith('/storage/v1/object/sign/chat/') &&
      url.searchParams.has('token') &&
      parseChatMediaUrl(value, scopeId)?.objectName === objectName
    )
  } catch {
    return false
  }
}

export function readChatUploadAcknowledgement(
  value: unknown,
  expected: {
    scopeId: string
    originalName: string
    fileType: string
    fileSize: number
    storageBaseUrl: string
  }
): ChatUploadAcknowledgement | null {
  const scopeId = expected.scopeId.toLowerCase()
  if (!UUID_PATTERN.test(scopeId) || !isRecord(value)) return null
  if (
    !hasExactKeys(value, ['category', 'fileName', 'fileSize', 'fileType', 'originalName', 'url']) ||
    value.originalName !== expected.originalName ||
    value.fileType !== expected.fileType ||
    value.fileSize !== expected.fileSize ||
    !Number.isSafeInteger(value.fileSize) ||
    (value.fileSize as number) <= 0 ||
    typeof value.fileName !== 'string' ||
    !['image', 'video', 'file'].includes(value.category as string)
  ) {
    return null
  }
  const category = value.category as ChatUploadAcknowledgement['category']
  if (
    !value.fileName.startsWith(`${scopeId}/${category}/`) ||
    !isCanonicalSignedUrl(value.url, scopeId, value.fileName, expected.storageBaseUrl)
  ) {
    return null
  }
  return {
    url: value.url,
    fileName: value.fileName,
    originalName: value.originalName as string,
    fileType: value.fileType as string,
    fileSize: value.fileSize as number,
    category,
  }
}
