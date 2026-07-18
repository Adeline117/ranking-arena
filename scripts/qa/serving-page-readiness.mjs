/**
 * User-visible readiness contracts for the serving browser gate.
 *
 * The homepage intentionally mounts deferred social/market widgets after its
 * server-rendered leaderboard is already usable. Waiting for global
 * `networkidle` makes those optional requests part of navigation and can time
 * out while 50 real ranking links are visible. Profiles keep the existing
 * network-idle contract; only the continuously active homepage uses its core
 * product surface as the readiness signal.
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

  return {
    waitUntil: 'networkidle',
    readySelector: null,
    readyTimeoutMs: 0,
    observeMs: 3_000,
  }
}
