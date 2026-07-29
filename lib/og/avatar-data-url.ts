const DEFAULT_TIMEOUT_MS = 4_000
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/]+={0,2})$/
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const

type OgAvatarMime = 'image/png' | 'image/jpeg'

export interface FetchOgAvatarDataUrlOptions {
  readonly proxyBaseUrl: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

function hasBytesAt(bytes: Uint8Array, expected: readonly number[], offset: number): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function hasValidImageEnvelope(bytes: Uint8Array, mime: OgAvatarMime): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return false
  if (mime === 'image/png') {
    return (
      bytes.byteLength >= PNG_SIGNATURE.length + PNG_IEND.length &&
      hasBytesAt(bytes, PNG_SIGNATURE, 0) &&
      hasBytesAt(bytes, PNG_IEND, bytes.byteLength - PNG_IEND.length)
    )
  }
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  )
}

function supportedMime(value: string | null): OgAvatarMime | null {
  if (!value) return null
  const normalized = value.split(';', 1)[0].trim().toLowerCase()
  if (normalized === 'image/png') return normalized
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg'
  return null
}

function decodeEmbeddedAvatar(value: string): { bytes: Uint8Array; mime: OgAvatarMime } | null {
  const match = DATA_URL_PATTERN.exec(value)
  if (!match || match[2].length > MAX_BASE64_LENGTH) return null
  const mime = supportedMime(match[1])
  if (!mime) return null
  try {
    const binary = atob(match[2])
    if (binary.length === 0 || binary.length > MAX_AVATAR_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return hasValidImageEnvelope(bytes, mime) ? { bytes, mime } : null
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return null

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_AVATAR_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }

  if (totalBytes === 0) return null
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function remoteAvatarUrl(value: string): string | null {
  if (value.length > 8_192 || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Return only a bounded PNG/JPEG data URL that Satori can safely consume.
 *
 * The same-origin avatar proxy remains responsible for SSRF/domain policy.
 * This final Edge boundary verifies the response MIME, byte envelope, and
 * maximum size before handing bytes to next/og's deferred renderer.
 */
export async function fetchOgAvatarDataUrl(
  avatarUrl: string | null | undefined,
  options: FetchOgAvatarDataUrlOptions
): Promise<string | null> {
  if (!avatarUrl) return null

  if (avatarUrl.startsWith('data:')) {
    const embedded = decodeEmbeddedAvatar(avatarUrl)
    return embedded ? `data:${embedded.mime};base64,${bytesToBase64(embedded.bytes)}` : null
  }

  const baseUrl = normalizedBaseUrl(options.proxyBaseUrl)
  const sourceUrl = remoteAvatarUrl(avatarUrl)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (
    !baseUrl ||
    !sourceUrl ||
    typeof fetchImpl !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    return null
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/avatar?url=${encodeURIComponent(sourceUrl)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const mime = supportedMime(response.headers.get('content-type'))
    if (!mime) return null

    const rawContentLength = response.headers.get('content-length')
    if (rawContentLength !== null) {
      if (!/^\d+$/.test(rawContentLength)) return null
      const contentLength = Number(rawContentLength)
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_AVATAR_BYTES) return null
    }

    const bytes = await readBoundedResponseBody(response)
    if (!bytes || !hasValidImageEnvelope(bytes, mime)) return null
    return `data:${mime};base64,${bytesToBase64(bytes)}`
  } catch {
    return null
  }
}
