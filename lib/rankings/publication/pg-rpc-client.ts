/**
 * Transaction-bound `rpc()` adapter over a node-postgres style executor.
 *
 * The publication modules (claim / cleanup / rerank / seal / bundle reader)
 * were written against the PostgREST envelope `{ data, error, status }`. The
 * worker must run the whole publication in ONE database transaction so a
 * failure rolls back to the previous sealed serving head; PostgREST cannot do
 * that across several calls. This adapter turns `rpc(name, args)` into
 * `SELECT public.name(p_x => $1, ...)` on the caller's transaction executor.
 *
 * It deliberately never throws: database errors become an `{ error }` envelope
 * with HTTP-like status 400 so every module surfaces them as deterministic
 * `rpc_error` (never as an ambiguous outcome that would trigger a retry on an
 * already-aborted transaction).
 */

export interface RankPublicationQueryResult<R> {
  rows: R[]
  rowCount: number | null
}

/** Smallest SQL capability the orchestrator needs (pg PoolClient fits). */
export interface RankPublicationSqlExecutor {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<RankPublicationQueryResult<R>>
}

export interface PgRpcEnvelope {
  data: unknown
  error: { code: string | null; message: string } | null
  status: number
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function describePgError(error: unknown): { code: string | null; message: string } {
  if (error && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    const message = Reflect.get(error, 'message')
    return {
      code: typeof code === 'string' && code !== '' ? code : null,
      message: typeof message === 'string' ? message : String(error),
    }
  }
  return { code: null, message: String(error) }
}

function encodeArgument(value: unknown): unknown {
  // Objects/arrays are jsonb parameters; scalars travel as text and are
  // coerced by PostgreSQL to the declared parameter type (uuid, int, ...).
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return value
}

async function execute(
  executor: RankPublicationSqlExecutor,
  name: string,
  args: unknown
): Promise<PgRpcEnvelope> {
  if (!IDENTIFIER.test(name)) {
    return {
      data: null,
      error: { code: '42601', message: `invalid RPC name ${name}` },
      status: 400,
    }
  }
  const entries =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : []
  for (const [key] of entries) {
    if (!IDENTIFIER.test(key)) {
      return {
        data: null,
        error: { code: '42601', message: `invalid RPC argument ${key}` },
        status: 400,
      }
    }
  }
  const named = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ')
  const values = entries.map(([, value]) => encodeArgument(value))
  try {
    const result = await executor.query<{ result: unknown }>(
      `SELECT public.${name}(${named}) AS result`,
      values
    )
    return { data: result.rows[0]?.result ?? null, error: null, status: 200 }
  } catch (error) {
    return { data: null, error: describePgError(error), status: 400 }
  }
}

/**
 * Build a PostgREST-shaped client whose every call runs on `executor`.
 * The returned query object is a plain thenable (no abortSignal binding):
 * cancellation is owned by the transaction's `statement_timeout`.
 */
export function createPgRpcClient(executor: RankPublicationSqlExecutor): {
  rpc: (name: string, args?: unknown) => PromiseLike<PgRpcEnvelope>
} {
  return {
    rpc(name: string, args?: unknown) {
      let pending: Promise<PgRpcEnvelope> | null = null
      return {
        then(onfulfilled, onrejected) {
          pending ??= execute(executor, name, args)
          return pending.then(onfulfilled, onrejected)
        },
      }
    },
  }
}
