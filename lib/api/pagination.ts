/**
 * Pagination utilities for API routes
 * Standardizes pagination parameter parsing and response format
 */

import type { PaginationMeta } from '../types/index'

/**
 * Default and maximum limits for pagination
 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200
const DEFAULT_OFFSET = 0

/**
 * Parsed pagination parameters
 */
export interface ParsedPagination {
  limit: number
  offset: number
}

/**
 * Parse pagination params from URL search params.
 * Clamps limit to [1, maxLimit] and offset to [0, Infinity].
 */
export function parsePaginationParams(
  searchParams: URLSearchParams,
  options: {
    defaultLimit?: number
    maxLimit?: number
  } = {}
): ParsedPagination {
  const { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = options

  const rawLimit = searchParams.get('limit')
  const rawOffset = searchParams.get('offset')

  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : defaultLimit
  const parsedOffset = rawOffset ? parseInt(rawOffset, 10) : DEFAULT_OFFSET

  const limit = Math.min(
    Math.max(isNaN(parsedLimit) ? defaultLimit : parsedLimit, 1),
    maxLimit
  )
  const offset = Math.max(isNaN(parsedOffset) ? DEFAULT_OFFSET : parsedOffset, 0)

  return { limit, offset }
}

/**
 * Build a standardized pagination meta object for API responses.
 */
export function buildPaginationMeta(params: {
  limit: number
  offset: number
  total?: number
  resultCount: number
}): PaginationMeta {
  const { limit, offset, total, resultCount } = params

  return {
    limit,
    offset,
    has_more: resultCount >= limit,
    ...(total !== undefined && { total }),
  }
}
