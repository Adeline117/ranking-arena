import { createHash } from 'node:crypto'

export const RAW_RPC_REQUEST_HASH_BASIS = 'utf8_json_rpc_request_body_bytes' as const
export const RAW_RPC_RESPONSE_HASH_BASIS =
  'fetch_content_decoded_http_entity_body_bytes_before_utf8' as const

export interface RawRpcBodyEvidence {
  bytes: Uint8Array
  sha256: string
  byteLength: number
}

export type BoundedRpcResponse =
  | { ok: true; text: string; bytes: Uint8Array | null }
  | {
      ok: false
      reason: 'response_too_large' | 'malformed_response' | 'raw_capture_unavailable'
    }

function bytesEvidence(bytes: Uint8Array): RawRpcBodyEvidence {
  const copy = new Uint8Array(bytes)
  return {
    bytes: copy,
    sha256: createHash('sha256').update(copy).digest('hex'),
    byteLength: copy.byteLength,
  }
}

export function encodeJsonRpcRequestBody(
  id: number,
  method: string,
  params: unknown[]
): { text: string; evidence: RawRpcBodyEvidence } {
  const text = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return { text, evidence: bytesEvidence(new TextEncoder().encode(text)) }
}

export function rawRpcBodyEvidence(bytes: Uint8Array): RawRpcBodyEvidence {
  return bytesEvidence(bytes)
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Raw transport failures must never be retained in evidence.
  }
}

function decodeUtf8(bytes: Uint8Array): BoundedRpcResponse {
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      bytes,
    }
  } catch {
    return { ok: false, reason: 'malformed_response' }
  }
}

function copyByteChunk(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value)) return null
  const view = value as ArrayBufferView & {
    readonly BYTES_PER_ELEMENT?: unknown
    readonly length?: unknown
  }
  if (
    view.BYTES_PER_ELEMENT !== 1 ||
    typeof view.length !== 'number' ||
    view.length !== view.byteLength
  ) {
    return null
  }
  try {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
  } catch {
    return null
  }
}

/**
 * Read the content-decoded HTTP entity body.
 *
 * Fetch implementations normally expose a ReadableStream after HTTP content
 * decoding. That production path is bounded while streaming and hashed before
 * UTF-8 decoding. A text-only test double remains usable for ordinary semantic
 * verification with a post-read size check, but it can never satisfy an exact
 * raw-capture request because re-encoding text is not the same evidence
 * boundary.
 */
export async function readBoundedRpcResponse(
  response: Response,
  maxBytes: number,
  requireExactBytes: boolean
): Promise<BoundedRpcResponse> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('invalid RPC response byte limit')
  }
  const contentLength = response.headers?.get?.('content-length')
  const hasCanonicalContentLength =
    typeof contentLength === 'string' && /^(?:0|[1-9]\d*)$/.test(contentLength)
  if (
    hasCanonicalContentLength &&
    (Number(contentLength) > maxBytes || !Number.isSafeInteger(Number(contentLength)))
  ) {
    await discardResponseBody(response)
    return { ok: false, reason: 'response_too_large' }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const copiedChunk = copyByteChunk(chunk.value)
      if (!copiedChunk) {
        try {
          await reader.cancel()
        } catch {
          // Fixed evidence reason only.
        }
        return { ok: false, reason: 'malformed_response' }
      }
      totalBytes += copiedChunk.byteLength
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // Fixed evidence reason only.
        }
        return { ok: false, reason: 'response_too_large' }
      }
      chunks.push(copiedChunk)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return decodeUtf8(bytes)
  }

  if (requireExactBytes) return { ok: false, reason: 'raw_capture_unavailable' }

  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, reason: 'response_too_large' }
  }
  return { ok: true, text, bytes: null }
}
