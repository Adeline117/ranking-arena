export const INGEST_JOB = {
  /** Tier A: full leaderboard crawl, all native TFs for one source. */
  TIER_A: 'tiera:leaderboard',
  /** Tier B: deep-profile crawl of topN for one source. */
  TIER_B: 'tierb:profiles',
  /** Tier B-S: slow series backfill for ranked traders beyond topN (spec §13.1). */
  TIER_B_SERIES: 'tierb:series',
  /** Tier C: on-demand single profile surface (priority 1, from Vercel). */
  TIER_C: 'tierc:profile',
  /** Tier D: open positions for top-100 of one source. */
  TIER_D: 'tierd:positions',
  /** Derived boards synthesis (MEXC/BTCC, spec §1.1-C). */
  DERIVE_BOARDS: 'derive:boards',
  /** Avatar mirroring (first-sight + weekly refresh). */
  AVATAR_MIRROR: 'maint:avatar-mirror',
  /** Partitions + RAW cleanup + downsample + retention. */
  MAINTENANCE: 'maint:housekeeping',
  /** Freshness SLA sentinel (spec §5.4). */
  FRESHNESS: 'maint:freshness',
  /** Daily digest of non-paging alerts (spec §15). */
  DAILY_DIGEST: 'maint:daily-digest',
  /** On-chain recompute of top-N web3 wallet profile detail (Phase A). */
  ONCHAIN_ENRICH: 'maint:onchain-enrich',
  /** First-party sync of a claimed trader's own account (认领 P1). */
  FIRST_PARTY: 'firstparty:sync',
} as const
