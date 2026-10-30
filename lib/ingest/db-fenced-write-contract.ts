/**
 * Pure SQL contract for writes made inside a worker database fence. Lives in
 * lib/ so publisher contract tests (and any lib caller) can exercise the exact
 * production validator without importing worker/. The worker fence module
 * re-exports these symbols, so error identity (`instanceof`) is unchanged.
 */

const WRITE_STATEMENT = /^(?:DELETE|INSERT|MERGE|SELECT|UPDATE|VALUES|WITH)\b/i
const FENCE_CONTROL_SQL =
  /\b(?:(?:activate|begin|release|renew)_ingest_worker_[a-z_]*|assert_ingest_worker_fence_at_commit|ingest_worker_(?:activations|authorities|instances|write_guards))\b/i

export type WorkerDbFenceOperation = 'acquire' | 'activate' | 'renew' | 'release' | 'write'
export type WorkerDbFenceErrorCode =
  | 'commit_aborted'
  | 'commit_outcome_unknown'
  | 'invalid_input'
  | 'invalid_state'
  | 'control_plane_unavailable'
  | 'db_control_outcome_unknown'
  | 'rpc_contract_violation'
  | 'fenced'
  | 'lease_deadline_exceeded'
  | 'write_deadline_exceeded'
export type WorkerDbFenceRetryPolicy = 'never' | 'exact_control_only' | 'reacquire'

export class WorkerDbFenceError extends Error {
  readonly code: WorkerDbFenceErrorCode
  readonly operation: WorkerDbFenceOperation
  readonly retryPolicy: WorkerDbFenceRetryPolicy

  constructor(
    code: WorkerDbFenceErrorCode,
    operation: WorkerDbFenceOperation,
    retryPolicy: WorkerDbFenceRetryPolicy
  ) {
    super(`[ingest-worker] worker database fence ${operation} failed (${code})`)
    this.name = 'WorkerDbFenceError'
    this.code = code
    this.operation = operation
    this.retryPolicy = retryPolicy
  }
}

function containsSelectInto(statement: string): boolean {
  const tokens: Array<{ keyword: string; scope: number }> = []
  const scopes = [0]
  let nextScope = 1
  for (let index = 0; index < statement.length; ) {
    const character = statement[index]
    if (character === "'") {
      index += 1
      while (index < statement.length) {
        if (statement[index] !== "'") {
          index += 1
          continue
        }
        if (statement[index + 1] === "'") {
          index += 2
          continue
        }
        index += 1
        break
      }
      continue
    }
    if (character === '(') {
      scopes.push(nextScope)
      nextScope += 1
      index += 1
      continue
    }
    if (character === ')') {
      if (scopes.length > 1) scopes.pop()
      index += 1
      continue
    }
    if (!/[A-Za-z_]/.test(character)) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < statement.length && /[A-Za-z0-9_$]/.test(statement[end])) end += 1
    tokens.push({ keyword: statement.slice(index, end).toUpperCase(), scope: scopes.at(-1) ?? 0 })
    index = end
  }

  const openSelectByScope = new Map<number, boolean>()
  for (const token of tokens) {
    if (token.keyword === 'SELECT') {
      openSelectByScope.set(token.scope, true)
    } else if (token.keyword === 'FROM') {
      openSelectByScope.set(token.scope, false)
    } else if (token.keyword === 'INTO' && openSelectByScope.get(token.scope) === true) {
      return true
    }
  }
  return false
}

/**
 * The exact SQL surface accepted by a fenced business transaction. Exported
 * so publisher contract tests exercise the production validator instead of a
 * second, drift-prone approximation.
 */
export function validateWorkerDbFencedWriteStatement(text: string): string {
  const statement = text.trim()
  if (
    statement.length === 0 ||
    statement.length > 1_000_000 ||
    statement.includes(';') ||
    /"|--|\/\*|\*\/|\$(?:\$|[A-Za-z_][A-Za-z0-9_]*\$)/.test(statement) ||
    !WRITE_STATEMENT.test(statement) ||
    FENCE_CONTROL_SQL.test(statement) ||
    containsSelectInto(statement) ||
    /\b(?:dblink|lo_export|lo_import|nextval|pg_advisory_(?:lock|unlock)[a-z_]*|pg_cancel_backend|pg_notify|pg_terminate_backend|set_config|setval)\s*\(/i.test(
      statement
    )
  ) {
    throw new WorkerDbFenceError('invalid_input', 'write', 'never')
  }
  return statement
}
