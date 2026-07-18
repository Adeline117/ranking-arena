/**
 * User-visible readiness contracts for the serving browser gate.
 *
 * The homepage intentionally mounts deferred social/market widgets after its
 * server-rendered leaderboard is already usable. Waiting for global
 * `networkidle` makes those optional requests part of navigation and can time
 * out while 50 real ranking links are visible. Profiles likewise trigger
 * optional enrichment after their core identity is usable, so they wait for
 * the visible profile heading rather than global provider idleness.
 */
export function servingPageReadiness(label) {
  if (label === 'home') {
    return {
      waitUntil: 'domcontentloaded',
      readySelector: 'main#main-content a[href^="/trader/"]:visible',
      readyTimeoutMs: 10_000,
      observeMs: 5_000,
    }
  }

  if (label.startsWith('active:') || label.startsWith('dormant:')) {
    return {
      waitUntil: 'domcontentloaded',
      readySelector: 'main#main-content h1:visible',
      readyTimeoutMs: 15_000,
      observeMs: 5_000,
    }
  }

  return {
    waitUntil: 'networkidle',
    readySelector: null,
    readyTimeoutMs: 0,
    observeMs: 3_000,
  }
}

export function isOptionalOnchainDegradation({ status, method, pathname, retryAfter }) {
  return (
    status === 503 &&
    method === 'POST' &&
    pathname === '/api/trader/onchain-enrich' &&
    typeof retryAfter === 'string' &&
    /^[1-9]\d*$/.test(retryAfter)
  )
}

export function isOptionalResourceConsoleError(message) {
  return /Failed to load resource: the server responded with a status of 503\b/.test(message)
}
