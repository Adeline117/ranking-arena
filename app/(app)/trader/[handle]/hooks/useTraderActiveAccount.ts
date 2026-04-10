'use client'

/**
 * useTraderActiveAccount — owns the linked-account state machine.
 *
 * Extracted from TraderProfileClient.tsx (2026-04-09 perf session). The
 * activeAccount string lives in URL `?account=platform:traderKey` form
 * for deep-link support. This hook owns:
 *
 *  - The state value (initialized from URL on mount)
 *  - Derived `activeAccountRaw` (parsed `{platform, traderKey}` or null)
 *  - The change handler that writes back to URL
 *
 * Critical invariant: `activeAccountRaw` is parsed inline from the
 * activeAccount string WITHOUT looking up linkedAccounts. This breaks
 * the cycle that previously caused the useLinkedAccounts waterfall —
 * the URL/SWR-key chain doesn't depend on linkedAccounts being loaded.
 */

import { useState, useCallback, useMemo } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export interface ActiveAccountRaw {
  platform: string
  traderKey: string
}

export interface UseTraderActiveAccountResult {
  /** Raw string state, "all" or "platform:traderKey" */
  activeAccount: string
  /** Parsed form, null when "all" */
  activeAccountRaw: ActiveAccountRaw | null
  /** Setter that also writes back to URL */
  handleAccountChange: (account: string) => void
}

export function useTraderActiveAccount(): UseTraderActiveAccountResult {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Initialize from URL on mount for deep-link support
  const urlAccount = searchParams.get('account')
  const [activeAccount, setActiveAccount] = useState<string>(urlAccount || 'all')

  // Parse "platform:traderKey" inline — NO linkedAccounts lookup.
  // Breaking the cycle here is what makes the SWR fetch order safe.
  const activeAccountRaw = useMemo<ActiveAccountRaw | null>(() => {
    if (activeAccount === 'all' || !activeAccount.includes(':')) return null
    const [platform, ...rest] = activeAccount.split(':')
    return { platform, traderKey: rest.join(':') }
  }, [activeAccount])

  const handleAccountChange = useCallback((account: string) => {
    setActiveAccount(account)
    const params = new URLSearchParams(searchParams.toString())
    if (account === 'all') {
      params.delete('account')
    } else {
      params.set('account', account)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  return { activeAccount, activeAccountRaw, handleAccountChange }
}
