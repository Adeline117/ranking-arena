/**
 * Evidence endpoint only. Live and captured behavior shows this follower view
 * can terminate at a top-50 boundary while later page numbers still contain
 * rows, so it cannot prove a `full` copier snapshot. Keep the exact URL for
 * audit capture, but do not export a publication verifier.
 */
export const BITGET_COPIER_HISTORY_URL =
  'https://www.bitget.com/v1/trigger/trace/trader/followerList' as const
