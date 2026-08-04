export type GroupPostCursor = {
  createdAt: string
  id: string
  isPinned: boolean | null
}

export type GroupPostCursorRow = {
  id: string
  created_at: string
  is_pinned?: boolean | null
}

export type GroupPostPaginationOperation = Readonly<{
  operationId: number
  scopeKey: string
  cursor: GroupPostCursor
}>

type ScopeState = {
  cursor: GroupPostCursor | null
  operation: GroupPostPaginationOperation | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const PAGINATION_SCOPE_LIMIT = 8

function isCursor(cursor: GroupPostCursor): boolean {
  return (
    TIMESTAMP_PATTERN.test(cursor.createdAt) &&
    Number.isFinite(Date.parse(cursor.createdAt)) &&
    UUID_PATTERN.test(cursor.id)
  )
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function pinFilter(isPinned: boolean | null): string {
  return isPinned === null ? 'is_pinned.is.null' : `is_pinned.eq.${String(isPinned)}`
}

export function groupPostCursorFromPage<T extends GroupPostCursorRow>(
  page: readonly T[]
): GroupPostCursor | null {
  const last = page.at(-1)
  if (!last) return null
  const cursor: GroupPostCursor = {
    createdAt: last.created_at,
    id: last.id,
    isPinned: typeof last.is_pinned === 'boolean' ? last.is_pinned : null,
  }
  return isCursor(cursor) ? cursor : null
}

/** Matches is_pinned DESC NULLS LAST, created_at DESC, id DESC. */
export function buildGroupPostCursorFilter(cursor: GroupPostCursor): string {
  if (!isCursor(cursor)) throw new Error('Invalid group post pagination cursor')
  const samePin = pinFilter(cursor.isPinned)
  const createdAt = quotePostgrestValue(cursor.createdAt)
  const filters = [
    `and(${samePin},created_at.lt.${createdAt})`,
    `and(${samePin},created_at.eq.${createdAt},id.lt.${cursor.id})`,
  ]
  if (cursor.isPinned === true) filters.push('is_pinned.eq.false', 'is_pinned.is.null')
  if (cursor.isPinned === false) filters.push('is_pinned.is.null')
  return filters.join(',')
}

export function appendUniqueGroupPosts<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  const seen = new Set(existing.map(({ id }) => id))
  const merged = [...existing]
  for (const post of incoming) {
    if (seen.has(post.id)) continue
    seen.add(post.id)
    merged.push(post)
  }
  return merged
}

/** Synchronous request ownership; React state is intentionally not used as a lock. */
export class GroupPostPaginationLedger {
  private readonly states = new Map<string, ScopeState>()
  private nextOperationId = 1

  reset(scopeKey: string, page: readonly GroupPostCursorRow[]): void {
    this.setState(scopeKey, { cursor: groupPostCursorFromPage(page), operation: null })
  }

  cursor(scopeKey: string): GroupPostCursor | null {
    return this.states.get(scopeKey)?.cursor ?? null
  }

  begin(scopeKey: string): GroupPostPaginationOperation | null {
    const state = this.states.get(scopeKey)
    if (!state?.cursor || state.operation) return null
    const operation = Object.freeze({
      operationId: this.nextOperationId++,
      scopeKey,
      cursor: state.cursor,
    })
    this.setState(scopeKey, { ...state, operation })
    return operation
  }

  advance(operation: GroupPostPaginationOperation, page: readonly GroupPostCursorRow[]): boolean {
    const state = this.states.get(operation.scopeKey)
    if (state?.operation !== operation) return false
    if (page.length === 0) return true
    const cursor = groupPostCursorFromPage(page)
    if (!cursor) return false
    this.setState(operation.scopeKey, { ...state, cursor })
    return true
  }

  finish(operation: GroupPostPaginationOperation): boolean {
    const state = this.states.get(operation.scopeKey)
    if (state?.operation !== operation) return false
    this.setState(operation.scopeKey, { ...state, operation: null })
    return true
  }

  private setState(scopeKey: string, state: ScopeState): void {
    this.states.delete(scopeKey)
    this.states.set(scopeKey, state)
    while (this.states.size > PAGINATION_SCOPE_LIMIT) {
      const oldest = this.states.keys().next().value as string | undefined
      if (!oldest) break
      this.states.delete(oldest)
    }
  }
}
