export interface CompareAccountRef {
  id: string
  source: string
}

export type CompareAccountParseError =
  | 'missing_ids'
  | 'missing_platforms'
  | 'empty_value'
  | 'length_mismatch'
  | 'duplicate_account'

export type CompareAccountParseResult =
  | { ok: true; accounts: CompareAccountRef[] }
  | { ok: false; error: CompareAccountParseError }

/**
 * A trader account is identified by both its platform and platform-local ID.
 * JSON encoding keeps the key unambiguous even when an ID contains punctuation.
 */
export function compareAccountKey(account: CompareAccountRef): string {
  return JSON.stringify([account.source, account.id])
}

export function isSameCompareAccount(left: CompareAccountRef, right: CompareAccountRef): boolean {
  return left.id === right.id && left.source === right.source
}

export function buildCompareUrl(accounts: CompareAccountRef[]): string {
  if (accounts.length === 0) return '/compare'

  const ids = accounts.map((account) => account.id).join(',')
  const platforms = accounts.map((account) => account.source).join(',')
  return `/compare?ids=${encodeURIComponent(ids)}&platforms=${encodeURIComponent(platforms)}`
}

export function buildCompareApiUrl(
  accounts: CompareAccountRef[],
  options: { includeEquity?: boolean } = {}
): string {
  const pageUrl = buildCompareUrl(accounts)
  const query = pageUrl.includes('?') ? pageUrl.slice(pageUrl.indexOf('?')) : ''
  return `/api/compare${query}${options.includeEquity ? `${query ? '&' : '?'}include_equity=1` : ''}`
}

/**
 * Parse the paired ids/platforms query parameters without ever falling back to
 * source-blind identity resolution.
 */
export function parseCompareAccounts(
  idsParam: string | null | undefined,
  platformsParam: string | null | undefined
): CompareAccountParseResult {
  if (idsParam == null || idsParam.trim() === '') {
    return { ok: false, error: 'missing_ids' }
  }
  if (platformsParam == null || platformsParam.trim() === '') {
    return { ok: false, error: 'missing_platforms' }
  }

  const ids = idsParam.split(',').map((value) => value.trim())
  const platforms = platformsParam.split(',').map((value) => value.trim())

  if (ids.some((value) => value === '') || platforms.some((value) => value === '')) {
    return { ok: false, error: 'empty_value' }
  }
  if (ids.length !== platforms.length) {
    return { ok: false, error: 'length_mismatch' }
  }

  const accounts = ids.map((id, index) => ({ id, source: platforms[index] }))
  const identities = new Set(accounts.map(compareAccountKey))
  if (identities.size !== accounts.length) {
    return { ok: false, error: 'duplicate_account' }
  }

  return { ok: true, accounts }
}

/**
 * Unified search IDs use `platform:traderKey`. Split only the first colon
 * because an exchange-local trader key may itself contain colons.
 */
export function parseUnifiedSearchTraderId(value: string): CompareAccountRef | null {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return null

  const source = value.slice(0, separator).trim()
  const id = value.slice(separator + 1).trim()
  return source && id ? { source, id } : null
}
