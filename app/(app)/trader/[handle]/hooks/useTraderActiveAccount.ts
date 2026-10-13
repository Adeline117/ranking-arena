'use client'

/**
 * useTraderActiveAccount — owns the linked-account state machine.
 *
 * Extracted from TraderProfileClient.tsx (2026-04-09 perf session). The
 * activeAccount string lives in URL `?account=platform:traderKey` form
 * for deep-link support. This hook owns:
 *
 *  - The state value (kept in sync with the URL)
 *  - Derived `activeAccountRaw` (parsed `{platform, traderKey}` or null)
 *  - The change handler that writes back to URL
 *
 * Critical invariant: `activeAccountRaw` is parsed inline from the
 * activeAccount string WITHOUT looking up linkedAccounts. This breaks
 * the cycle that previously caused the useLinkedAccounts waterfall —
 * the URL/SWR-key chain doesn't depend on linkedAccounts being loaded.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { replaceUrlShallow } from './replaceUrlShallow'

const MAX_PLATFORM_LENGTH = 64
const MAX_TRADER_KEY_LENGTH = 512

export interface ActiveAccountRaw {
  platform: string
  traderKey: string
}

export type TraderActiveAccountParam =
  | {
      kind: 'all'
      activeAccount: 'all'
      activeAccountRaw: null
    }
  | {
      kind: 'account'
      activeAccount: string
      activeAccountRaw: ActiveAccountRaw
    }
  | {
      kind: 'invalid'
      activeAccount: 'all'
      activeAccountRaw: null
    }

const ALL_ACCOUNTS: TraderActiveAccountParam = {
  kind: 'all',
  activeAccount: 'all',
  activeAccountRaw: null,
}

const INVALID_ACCOUNT: TraderActiveAccountParam = {
  kind: 'invalid',
  activeAccount: 'all',
  activeAccountRaw: null,
}

/**
 * Parse the canonical `platform:traderKey` URL value. The first colon is the
 * separator; subsequent colons are part of the trader key.
 */
export function parseTraderActiveAccountParam(value: string | null): TraderActiveAccountParam {
  if (value === null || value === 'all') return ALL_ACCOUNTS

  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0) return INVALID_ACCOUNT

  const platform = value.slice(0, separatorIndex)
  const traderKey = value.slice(separatorIndex + 1)
  const isValid =
    platform.length <= MAX_PLATFORM_LENGTH &&
    traderKey.length > 0 &&
    traderKey.length <= MAX_TRADER_KEY_LENGTH &&
    platform === platform.trim() &&
    traderKey === traderKey.trim()

  if (!isValid) return INVALID_ACCOUNT

  return {
    kind: 'account',
    activeAccount: value,
    activeAccountRaw: { platform, traderKey },
  }
}

export interface UseTraderActiveAccountResult {
  /** Raw string state, "all" or "platform:traderKey" */
  activeAccount: string
  /** Parsed form, null when "all" */
  activeAccountRaw: ActiveAccountRaw | null
  /** True while a malformed URL account parameter is being removed. */
  isAccountParamInvalid: boolean
  /** Setter that also writes back to URL */
  handleAccountChange: (account: string) => void
}

interface PendingAccountSelection {
  /** Search snapshot against which the navigation was requested. */
  sourceSearchParams: string
  selection: TraderActiveAccountParam
}

export function useTraderActiveAccount(): UseTraderActiveAccountResult {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsString = searchParams.toString()

  const urlAccount = useMemo<TraderActiveAccountParam>(() => {
    const params = new URLSearchParams(searchParamsString)
    const accountValues = params.getAll('account')
    if (accountValues.length > 1) return INVALID_ACCOUNT
    return parseTraderActiveAccountParam(accountValues[0] ?? null)
  }, [searchParamsString])

  const [pendingSelection, setPendingSelection] = useState<PendingAccountSelection | null>(null)

  useEffect(() => {
    // Once navigation changes the search snapshot, the URL is authoritative.
    // Clearing the optimistic selection also prevents it from resurfacing if
    // the user later navigates back to the same query string.
    setPendingSelection(null)

    if (urlAccount.kind !== 'invalid') return

    const params = new URLSearchParams(searchParamsString)
    params.delete('account')
    const query = params.toString()
    replaceUrlShallow(`${pathname}${query ? `?${query}` : ''}`)
  }, [pathname, searchParamsString, urlAccount])

  // A malformed URL is never exposed, including during the render before the
  // cleanup effect removes it. A pending control selection is used only while
  // the URL still matches the snapshot from which that navigation began.
  const exposedSelection =
    urlAccount.kind !== 'invalid' && pendingSelection?.sourceSearchParams === searchParamsString
      ? pendingSelection.selection
      : urlAccount.kind === 'invalid'
        ? ALL_ACCOUNTS
        : urlAccount

  const handleAccountChange = useCallback(
    (account: string) => {
      const nextSelection = parseTraderActiveAccountParam(account)
      const canonicalSelection = nextSelection.kind === 'invalid' ? ALL_ACCOUNTS : nextSelection
      setPendingSelection({
        sourceSearchParams: searchParamsString,
        selection: canonicalSelection,
      })

      const params = new URLSearchParams(searchParamsString)
      if (canonicalSelection.kind === 'all') {
        params.delete('account')
      } else {
        params.set('account', canonicalSelection.activeAccount)
      }
      const query = params.toString()
      replaceUrlShallow(`${pathname}${query ? `?${query}` : ''}`)
    },
    [pathname, searchParamsString]
  )

  return {
    activeAccount: exposedSelection.activeAccount,
    activeAccountRaw: exposedSelection.activeAccountRaw,
    isAccountParamInvalid: urlAccount.kind === 'invalid',
    handleAccountChange,
  }
}
