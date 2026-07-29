/**
 * Minimal edge-safe Supabase RPC client.
 *
 * Ranking OG/badge routes cannot use the Node Supabase client, but the sealed
 * generation helpers need only `.rpc()` plus `.abortSignal()`. This adapter
 * preserves that exact transport shape over PostgREST fetch.
 */

const RPC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const MAX_ERROR_MESSAGE_LENGTH = 500

export interface SupabaseRestRpcError {
  readonly message: string
  readonly status: number
  readonly code?: string
}

export interface SupabaseRestRpcEnvelope {
  readonly data: unknown
  readonly error: SupabaseRestRpcError | null
  readonly status: number
}

export interface SupabaseRestRpcQuery extends PromiseLike<SupabaseRestRpcEnvelope> {
  abortSignal(signal: AbortSignal): SupabaseRestRpcQuery
}

export interface SupabaseRestRpcClient {
  rpc(name: string, args?: Record<string, unknown>): SupabaseRestRpcQuery
}

function requireBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('Supabase REST RPC URL is invalid')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Supabase REST RPC URL is invalid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Supabase REST RPC URL must use HTTP or HTTPS')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Supabase REST RPC URL is invalid')
  }
  return parsed.href.replace(/\/+$/, '')
}

function requireServiceKey(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 32_768 ||
    value.trim() !== value ||
    /[\r\n]/.test(value)
  ) {
    throw new TypeError('Supabase REST RPC service key is invalid')
  }
  return value
}

function responseError(payload: unknown, status: number): SupabaseRestRpcError {
  let message = `Supabase REST RPC failed with status ${status}`
  let code: string | undefined
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    if (typeof record.message === 'string') message = record.message
    if (typeof record.code === 'string' && record.code.length > 0) code = record.code
  }
  return {
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    status,
    ...(code ? { code } : {}),
  }
}

async function parseResponse(response: Response): Promise<SupabaseRestRpcEnvelope> {
  const raw = await response.text()
  let payload: unknown = null
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw)
    } catch {
      return {
        data: null,
        error: {
          message: 'Supabase REST RPC returned invalid JSON',
          status: response.status,
        },
        status: response.status,
      }
    }
  }
  if (!response.ok) {
    return {
      data: null,
      error: responseError(payload, response.status),
      status: response.status,
    }
  }
  return { data: payload, error: null, status: response.status }
}

export function createSupabaseRestRpcClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch
): SupabaseRestRpcClient {
  const baseUrl = requireBaseUrl(supabaseUrl)
  const key = requireServiceKey(serviceRoleKey)
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Supabase REST RPC fetch implementation is invalid')
  }

  return Object.freeze({
    rpc(name: string, args: Record<string, unknown> = {}): SupabaseRestRpcQuery {
      if (!RPC_NAME_PATTERN.test(name)) {
        throw new TypeError('Supabase REST RPC name is invalid')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('Supabase REST RPC args must be an object')
      }

      let signal: AbortSignal | undefined
      let dispatched: Promise<SupabaseRestRpcEnvelope> | undefined
      const query: SupabaseRestRpcQuery = {
        abortSignal(nextSignal: AbortSignal) {
          if (!(nextSignal instanceof AbortSignal)) {
            throw new TypeError('Supabase REST RPC AbortSignal is invalid')
          }
          if (dispatched) {
            throw new Error('Supabase REST RPC request was already dispatched')
          }
          signal = nextSignal
          return query
        },
        then<TResult1 = SupabaseRestRpcEnvelope, TResult2 = never>(
          onfulfilled?:
            | ((value: SupabaseRestRpcEnvelope) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          dispatched ??= fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
            signal,
          }).then(parseResponse)
          return dispatched.then(onfulfilled, onrejected)
        },
      }
      return query
    },
  })
}
